/*
  protostar.js - animated protostar background for the home page.
  A point of light ignites, launches a bipolar jet, and the collapsing envelope
  settles into a Keplerian disk that keeps rotating behind the page content.

  Falls back to the HL Tau background image in main_style.css when WebGL2 is
  unavailable. For testing: add ?t=4&freeze to the URL to freeze on a moment.
  Performance: capped frame rate, a fixed render-resolution budget, and automatic
  quality reduction on slow machines (see CONFIG).

  Joshua Note:
  This simulation was originally written in C++, however after seeing it I wanted to include it on my website!
  However, I am a creature of the backend and had little interest (at the time) in learning js, so this is the
  ai translated version of my C++ sim to javascript.
  It's very pretty, but it's not the original C++.
*/
(() => {
const CONFIG = {
  fadeToImage: false,         // true = after the intro, crossfade to the HL Tau ALMA image
  fadeAt: 11,                 // seconds (only used when fadeToImage is true)
  introOncePerSession: true,  // coming back to Home in the same tab skips to the settled disk
  maxFps: 30,                 // frame cap once the disk has settled (the intro runs at up to 60)
  scrolledFps: 20,            // frame cap once the reader has scrolled past the first screen
  maxPixels: 1.2e6            // render-resolution budget (~1460x820); the glow hides the upscaling
};
const TJ = 2.0, SKIP_TO = 10.5, TEXT_AT = 6.5;

const body = document.body;
const canvas = document.createElement('canvas');
canvas.id = 'protostar-bg'; canvas.setAttribute('aria-hidden', 'true');
body.prepend(canvas);
const gl = canvas.getContext('webgl2', {antialias:false, alpha:false, powerPreference:'low-power'});
if (!gl) { canvas.remove(); return; }            // HL Tau image stays as the background

const qs = new URLSearchParams(location.search);
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const small = Math.min(innerWidth, innerHeight) < 700;
const Q = small ? 0.45 : 1.0;                    // particle budget scale
const N_DISK = Math.round(60000*Q), N_BURST = Math.round(7000*Q),
      N_JET = Math.round(11000*Q),   N_STARS = Math.round(1500*Q);
// Fewer, slightly larger particles; brightness is rescaled so the look matches the original.
const SIZE_K = [1.3, 1.15, 1.2];
const GAIN_K = [150000/N_DISK, 14000/N_BURST, 26000/N_JET].map((g,i) => g/(SIZE_K[i]*SIZE_K[i]));

let seen = false;
try {
  seen = CONFIG.introOncePerSession && sessionStorage.getItem('protostarSeen') === '1';
  sessionStorage.setItem('protostarSeen', '1');
} catch (e) {}
const skipIntro = reduced || seen;

const ctrl = document.createElement('button');
ctrl.id = 'protostar-ctrl'; ctrl.type = 'button';

try {
/* ------------------------------ shaders ------------------------------ */
const QUAD_VS = `#version 300 es
layout(location=0) in vec2 aPos; out vec2 vUv;
void main(){ vUv=aPos*.5+.5; gl_Position=vec4(aPos,0.,1.); }`;

// Background: faint nebula + the central star (core, halo, spikes, launch flash)
const GLOW_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform vec2 uRes; uniform float uStar, uFlash, uNeb, uRoll; uniform sampler2D uNebTex;
void main(){
  vec2 p=(gl_FragCoord.xy-.5*uRes)/uRes.y;
  float q2=dot(p,p);
  vec3 col = uNeb*texture(uNebTex,vUv).rgb;                  // pre-baked nebula
  // reflection glow of the envelope
  col += uStar*vec3(.45,.28,.22)*.05*exp(-sqrt(q2)*5.);
  // star core + halo
  vec3 sc=vec3(1.,.93,.82);
  col += sc*uStar*( 9.*exp(-q2/(2.*.0022*.0022)) + .5*.0005/(q2+.0005) );
  // diffraction spikes (rotate with camera roll)
  float c=cos(uRoll), s=sin(uRoll); vec2 r=vec2(c*p.x-s*p.y, s*p.x+c*p.y);
  float sp = exp(-abs(r.y)*1400.)*exp(-abs(r.x)*16.) + exp(-abs(r.x)*1400.)*exp(-abs(r.y)*16.);
  col += sc*uStar*sp*.6;
  // jet-launch flash
  col += vec3(.75,.85,1.)*uFlash*( 1.2*.0015/(q2+.0015) + .35*exp(-q2*10.) );
  o=vec4(col,1.);
}`;

// Nebula noise: rendered once per resize into a small texture
const NEB_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o;
uniform vec2 uRes;
float hash(vec2 p){ p=fract(p*vec2(123.34,456.21)); p+=dot(p,p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float fbm(vec2 p){ float v=0., a=.5; for(int i=0;i<5;i++){ v+=a*noise(p); p=p*2.03+vec2(1.7,9.2); a*=.5; } return v; }
void main(){
  vec2 p=(gl_FragCoord.xy-.5*uRes)/uRes.y;
  float n1=fbm(p*2.2+3.), n2=fbm(p*4.5-7.);
  o=vec4(vec3(.10,.035,.16)*pow(n1,3.)*1.2 + vec3(.02,.05,.10)*pow(n2,2.)*.8, 1.);
}`;

// One VS computes every particle's position analytically from (seed, time).
const PART_VS = `#version 300 es
precision highp float;
layout(location=0) in vec4 aSeed;
layout(location=1) in float aType;   // 0 disk/envelope, 1 jet burst, 2 steady jet, 3 background star
uniform mat4 uProj, uView;
uniform float uTime, uScale, uPx; uniform vec3 uGain, uSizeK;
out vec3 vCol; out float vA;
const float TJ=${TJ.toFixed(2)}, TD=2.3, RIN=.16, ROUT=4.2, TAU=6.2831853;
float h(float x){ return fract(sin(x*12.9898+78.233)*43758.5453); }
void main(){
  float t=uTime; vec4 s=aSeed;
  float h1=h(s.x+s.y*3.1), h2=h(s.z+s.w*7.3), h3=h(s.x*5.7+s.w), h4=h(s.y*2.3+s.z*4.1);
  vec3 pos, col; float a, size; bool fixedPx=false;

  if(aType<.5){
    /* ---- envelope -> Keplerian disk ---- */
    float r   = RIN+(ROUT-RIN)*pow(s.x,1.25);
    float phi0= s.y*TAU;
    float zs  = (s.z+s.w+h1-1.5)*2.;                 // ~gaussian scale height units
    float H   = .055*pow(r,1.25);                    // flared disk
    float om  = .6*pow(r,-1.5);                      // Keplerian
    float ts  = TD+3.2*pow(r/ROUT,.9)+h2;            // inside-out formation
    float p   = clamp((t-ts)/(1.6+1.2*r/ROUT),0.,1.);
    float e   = 1.-pow(1.-p,3.);
    float R0  = 5.5+3.5*h3, cth=2.*h4-1., sth=sqrt(1.-cth*cth);
    float col0= 1.-.12*smoothstep(0.,ts,t);          // slow pre-collapse
    float rad = mix(R0*sth*col0, r, e);
    float y   = mix(R0*cth*col0, zs*H, e);
    float phi = phi0+.03*min(t,ts)+2.2*e+om*max(t-ts,0.)*smoothstep(0.,1.,p);
    pos=vec3(rad*cos(phi), y, rad*sin(phi));

    float tr=smoothstep(RIN,ROUT,r);
    vec3 dc=mix(vec3(1.,.93,.82), vec3(1.,.55,.22), smoothstep(0.,.35,tr));
    dc=mix(dc, vec3(.55,.22,.16), smoothstep(.35,1.,tr));
    float b=.16*pow(r/RIN,-.62);
    b*=.55+.9*pow(.5+.5*sin(3.*phi0+5.*log(r)),3.);          // initial spiral -> shears out
    float lane=mix(1., smoothstep(.1,1.3,abs(zs)), smoothstep(.45,1.4,r)); // dark midplane dust lane
    b*=mix(1.,lane,e);
    float lit=smoothstep(.8,2.2,t);
    float cb=.028*lit*(.4+.6*smoothstep(9.,4.,rad));
    col=mix(vec3(.35,.42,.7), dc, e);
    a=mix(cb, b, e) + .35*e*(1.-e);                           // infalling gas heats up
    size=(.024+.018*h2)*(.7+.3*r);
  } else if(aType<1.5){
    /* ---- initial jet burst ---- */
    float side=s.x<.5?-1.:1.;
    float age=t-(TJ+s.y*s.y*.35);
    if(age<0.){ gl_Position=vec4(2,2,2,1); gl_PointSize=0.; vA=0.; vCol=vec3(0); return; }
    float v=9.*(.45+.55*s.z);
    float d=v*age/(1.+.6*age);
    float ang=s.w*TAU;
    float lat=d*(.035+.05*h1)+step(.85,s.z)*d*.22*h1*h1;      // cone + bow-shock wings
    pos=vec3(lat*cos(ang), side*d, lat*sin(ang));
    col=mix(vec3(.75,.85,1.), vec3(1.,.35,.45), smoothstep(0.,2.5,age));
    a=.9*exp(-age*.7)*(.6+.8*h2);
    size=.05+.05*h3;
  } else if(aType<2.5){
    /* ---- steady, episodic, precessing jet ---- */
    float side=s.x<.5?-1.:1.;
    float P=3.2, t0=t-TJ-.3, off=s.y*P;
    if(t0<off){ gl_Position=vec4(2,2,2,1); gl_PointSize=0.; vA=0.; vCol=vec3(0); return; }
    float age=mod(t0-off,P), la=t-age;
    float d=3.6*(.9+.2*s.z)*age+.15;
    float ang=s.w*TAU;
    float lat=(.025+.035*d)*sqrt(h1);
    vec2 pw=.035*d*vec2(cos(la*.9),sin(la*.9));
    pos=vec3(lat*cos(ang)+pw.x, side*d, lat*sin(ang)+pw.y);
    float k=fract(la/1.1+(side>0.?0.:.37));
    float knot=.2+2.*exp(-k*k*80.);                            // Herbig-Haro knots
    col=mix(vec3(.8,.88,1.), vec3(1.,.32,.4), smoothstep(.3,4.,d));
    a=.26*knot*smoothstep(11.,4.,d)*smoothstep(0.,.4,d)*smoothstep(TJ+.2,TJ+2.,t);
    size=.04+.03*h3;
  } else {
    /* ---- background stars ---- */
    float th=acos(2.*s.x-1.), ph=s.y*TAU;
    pos=80.*vec3(sin(th)*cos(ph), cos(th), sin(th)*sin(ph));
    col=mix(vec3(.7,.8,1.), vec3(1.,.85,.7), s.z);
    a=(.03+1.5*pow(s.w,6.))*smoothstep(0.,1.2,t);
    size=1.2+2.*pow(s.w,8.); fixedPx=true;
  }

  if(aType<.5){ a*=uGain.x; size*=uSizeK.x; }
  else if(aType<1.5){ a*=uGain.y; size*=uSizeK.y; }
  else if(aType<2.5){ a*=uGain.z; size*=uSizeK.z; }

  vec4 mv=uView*vec4(pos,1.);
  if(mv.z>-.1){ gl_Position=vec4(2,2,2,1); gl_PointSize=0.; vA=0.; vCol=vec3(0); return; }
  gl_Position=uProj*mv;
  float px = fixedPx ? size*uPx : size*uScale/(-mv.z);
  float mn=max(1.5*uPx,1.);
  if(px<mn){ a*=(px/mn)*(px/mn); px=mn; }                    // keep energy for sub-pixel points
  gl_PointSize=min(px,64.);
  vCol=col; vA=a;
}`;

const PART_FS = `#version 300 es
precision mediump float;
in vec3 vCol; in float vA; out vec4 o;
void main(){ vec2 c=gl_PointCoord*2.-1.; float d=dot(c,c); if(d>1.) discard;
  o=vec4(vCol*vA*exp(-d*3.5)*(1.-d),1.); }`;

const BRIGHT_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform float uThr;
void main(){ vec3 c=texture(uTex,vUv).rgb; o=vec4(max(c-uThr,0.),1.); }`;

const BLUR_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uTex; uniform vec2 uDir;
void main(){
  vec3 c=texture(uTex,vUv).rgb*.227027;
  c+=(texture(uTex,vUv+uDir*1.3846).rgb+texture(uTex,vUv-uDir*1.3846).rgb)*.316216;
  c+=(texture(uTex,vUv+uDir*3.2308).rgb+texture(uTex,vUv-uDir*3.2308).rgb)*.070270;
  o=vec4(c,1.); }`;

const COMP_FS = `#version 300 es
precision highp float; in vec2 vUv; out vec4 o;
uniform sampler2D uScene, uB1, uB2; uniform float uExp; uniform vec2 uRes;
vec3 aces(vec3 x){ return clamp((x*(2.51*x+.03))/(x*(2.43*x+.59)+.14),0.,1.); }
void main(){
  vec3 c=texture(uScene,vUv).rgb + texture(uB1,vUv).rgb*.8 + texture(uB2,vUv).rgb*1.1;
  c=aces(c*uExp);
  c=pow(c,vec3(1./2.2));
  vec2 v=vUv-.5; c*=1.-.55*dot(v,v)*1.6;                     // vignette
  c+=(fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-.5)/255.; // dither
  o=vec4(c,1.); }`;

/* ------------------------------ GL helpers ------------------------------ */
function compile(type, src){
  const sh=gl.createShader(type); gl.shaderSource(sh,src); gl.compileShader(sh);
  if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
function program(vs, fs){
  const p=gl.createProgram();
  gl.attachShader(p,compile(gl.VERTEX_SHADER,vs)); gl.attachShader(p,compile(gl.FRAGMENT_SHADER,fs));
  gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const cache={};
  return {p, u:n=>(n in cache?cache[n]:(cache[n]=gl.getUniformLocation(p,n)))};
}
const P = {
  glow: program(QUAD_VS,GLOW_FS), neb: program(QUAD_VS,NEB_FS), part: program(PART_VS,PART_FS),
  bright: program(QUAD_VS,BRIGHT_FS), blur: program(QUAD_VS,BLUR_FS), comp: program(QUAD_VS,COMP_FS)
};

// fullscreen triangle
const quadVao=gl.createVertexArray(); gl.bindVertexArray(quadVao);
gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer());
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);

// particles
const N = N_DISK+N_BURST+N_JET+N_STARS;
const seeds=new Float32Array(N*4), types=new Float32Array(N);
for(let i=0;i<N*4;i++) seeds[i]=Math.random();
for(let i=0;i<N;i++) types[i]= i<N_DISK?0 : i<N_DISK+N_BURST?1 : i<N_DISK+N_BURST+N_JET?2 : 3;
const partVao=gl.createVertexArray(); gl.bindVertexArray(partVao);
gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER,seeds,gl.STATIC_DRAW);
gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,4,gl.FLOAT,false,0,0);
gl.bindBuffer(gl.ARRAY_BUFFER,gl.createBuffer()); gl.bufferData(gl.ARRAY_BUFFER,types,gl.STATIC_DRAW);
gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,1,gl.FLOAT,false,0,0);
gl.bindVertexArray(null);

// render targets (HDR when supported)
const hdr=!!gl.getExtension('EXT_color_buffer_float');
function target(w,h){
  const tex=gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D,tex);
  gl.texImage2D(gl.TEXTURE_2D,0,hdr?gl.RGBA16F:gl.RGBA8,w,h,0,gl.RGBA,hdr?gl.HALF_FLOAT:gl.UNSIGNED_BYTE,null);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  const fb=gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER,fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);
  return {tex,fb,w,h,free(){gl.deleteTexture(tex);gl.deleteFramebuffer(fb);}};
}
let T={}, W=0, H=0, dpr=1, quality=1;          // quality drops automatically on slow machines
function resize(){
  const cw=innerWidth, ch=innerHeight;
  dpr=Math.min(devicePixelRatio||1, 2, Math.sqrt(CONFIG.maxPixels*quality/(cw*ch)));
  const w=Math.max(2,Math.round(cw*dpr)), h=Math.max(2,Math.round(ch*dpr));
  if(w===W&&h===H) return;
  W=canvas.width=w; H=canvas.height=h;
  Object.values(T).forEach(t=>t.free());
  const w2=w>>1,h2=h>>1,w4=w>>2,h4=h>>2;
  T={scene:target(w,h), a1:target(w2,h2), b1:target(w2,h2), a2:target(w4,h4), b2:target(w4,h4), neb:target(w4,h4)};
  pass(P.neb,T.neb); gl.uniform2f(P.neb.u('uRes'),w4,h4); gl.drawArrays(gl.TRIANGLES,0,3);
}
let resizeTimer=0;
addEventListener('resize',()=>{ clearTimeout(resizeTimer); resizeTimer=setTimeout(resize,200); });

/* ------------------------------ math ------------------------------ */
const FOV=35*Math.PI/180;
function persp(f,a,n,fa){const t=1/Math.tan(f/2);return [t/a,0,0,0, 0,t,0,0, 0,0,(fa+n)/(n-fa),-1, 0,0,2*fa*n/(n-fa),0];}
function lookAt(e,c){
  let z=[e[0]-c[0],e[1]-c[1],e[2]-c[2]], l=Math.hypot(...z); z=z.map(v=>v/l);
  let x=[z[2],0,-z[0]]; l=Math.hypot(...x); x=x.map(v=>v/l);              // up=(0,1,0) x z
  const y=[z[1]*x[2]-z[2]*x[1], z[2]*x[0]-z[0]*x[2], z[0]*x[1]-z[1]*x[0]];
  const d=(a,b)=>a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  return [x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -d(x,e),-d(y,e),-d(z,e),1];
}
function mul(a,b){const o=new Array(16);for(let c=0;c<4;c++)for(let r=0;r<4;r++){let s=0;for(let k=0;k<4;k++)s+=a[k*4+r]*b[c*4+k];o[c*4+r]=s;}return o;}
const rotZ=r=>[Math.cos(r),Math.sin(r),0,0, -Math.sin(r),Math.cos(r),0,0, 0,0,1,0, 0,0,0,1];
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const sstep=(a,b,x)=>{const u=clamp((x-a)/(b-a),0,1);return u*u*(3-2*u);};

function starI(t){
  if(t<.8) return 0;
  if(t>=TJ) return 1+.03*Math.sin(t*1.7);
  const u=sstep(.8,TJ,t);
  return u*u*(.9+.12*Math.sin(t*41)*Math.sin(t*17))*(1+2*sstep(1.7,TJ,t));
}

function pass(prog, dst){ gl.bindFramebuffer(gl.FRAMEBUFFER,dst?dst.fb:null);
  gl.viewport(0,0,dst?dst.w:W,dst?dst.h:H); gl.useProgram(prog.p); gl.bindVertexArray(quadVao); }
function tex(unit,t){ gl.activeTexture(gl.TEXTURE0+unit); gl.bindTexture(gl.TEXTURE_2D,t.tex); }
resize();
function blur(src,tmp){
  for(let i=0;i<2;i++){
    pass(P.blur,tmp); tex(0,src); gl.uniform1i(P.blur.u('uTex'),0); gl.uniform2f(P.blur.u('uDir'),(1+i)/src.w,0); gl.drawArrays(gl.TRIANGLES,0,3);
    pass(P.blur,src); tex(0,tmp); gl.uniform2f(P.blur.u('uDir'),0,(1+i)/src.h); gl.drawArrays(gl.TRIANGLES,0,3);
  }
}


/* ------------------------------ state ------------------------------ */
body.dataset.hero = 'sim';
body.appendChild(ctrl);

let t0 = performance.now(), offset = qs.has('t') ? +qs.get('t') : (skipIntro ? SKIP_TO : 0);
const freeze = qs.has('freeze'), bench = qs.has('bench'), speed = reduced ? 0.35 : 1;
const now = () => freeze ? offset : (performance.now()-t0)/1000*speed + offset;
let mx=0, my=0, cmx=0, cmy=0, raf=0, lastDraw=-1e9, slowAvg=0, drawn=0, faded=false, introDone=true;
addEventListener('pointermove', e => { mx=e.clientX/innerWidth*2-1; my=e.clientY/innerHeight*2-1; });

function startIntro(){ introDone=false; body.classList.add('protostar-intro'); ctrl.textContent='Skip intro'; }
function endIntro(){ introDone=true; body.classList.remove('protostar-intro'); ctrl.textContent='Replay'; }
offset < TEXT_AT ? startIntro() : endIntro();
addEventListener('scroll', () => { if (!introDone && scrollY > 40) endIntro(); }, {passive:true});

function restart(to){
  t0=performance.now(); offset=to; faded=false;
  canvas.classList.remove('faded'); body.dataset.hero='sim';
  to < TEXT_AT ? startIntro() : endIntro();
  if (!raf) raf=requestAnimationFrame(frame);
}
ctrl.onclick = () => introDone ? restart(0) : restart(SKIP_TO);

/* ------------------------------ frame ------------------------------ */
function frame(ts){
  raf=0;
  const t=now();
  if (!introDone && t>=TEXT_AT) endIntro();
  if (CONFIG.fadeToImage && !faded && t>=CONFIG.fadeAt){ faded=true; canvas.classList.add('faded'); body.dataset.hero='image'; }
  if (faded && t>=CONFIG.fadeAt+3.5) return;                    // fully faded: stop rendering
  // once the reader is past the first screen (content mostly covers it), draw at ~30 fps
  // frame cap: smooth during the intro, gentler afterwards, gentler still when scrolled past
  const fps = bench ? 1000 : scrollY>innerHeight*1.2 ? CONFIG.scrolledFps : t<SKIP_TO ? 60 : CONFIG.maxFps;
  if (!freeze && ts-lastDraw < 1000/fps-4){ raf=requestAnimationFrame(frame); return; }
  const gap=ts-lastDraw; lastDraw=ts;
  // adaptive quality: if frames keep arriving late, render at a lower resolution
  if (!bench && !freeze && gap<500){
    slowAvg = slowAvg*.95 + (gap > 1.5*1000/fps ? 1 : 0)*.05;
    if (++drawn>60 && slowAvg>.5 && quality>.3){ quality*=.7; slowAvg=0; drawn=0; resize(); }
  }
  draw(t); window.__draws=(window.__draws||0)+1;
  if (!freeze) raf=requestAnimationFrame(frame); else window.__rendered=true;
}

function draw(t){
  cmx+=(mx-cmx)*.03; cmy+=(my-cmy)*.03;
  const intro=sstep(0,9,t);
  const D=17-6*intro;
  const inc=1.2+cmy*.1, az=.4+cmx*.25+t*.004, roll=.32;
  const sh=t>TJ?Math.exp(-(t-TJ)*4)*.12:0;
  const eye=[D*Math.sin(inc)*Math.cos(az), D*Math.cos(inc), D*Math.sin(inc)*Math.sin(az)];
  const tgt=[sh*Math.sin(t*53), sh*Math.sin(t*47), sh*Math.cos(t*59)];
  const view=mul(rotZ(roll), lookAt(eye,tgt));
  const proj=persp(FOV,W/H,.1,300);
  const star=starI(t), flash=t>=TJ?Math.exp(-(t-TJ)*2.2):0;

  // scene
  gl.bindFramebuffer(gl.FRAMEBUFFER,T.scene.fb); gl.viewport(0,0,W,H);
  gl.clearColor(0,0,0,1); gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE);
  pass(P.glow,T.scene);
  tex(0,T.neb); gl.uniform1i(P.glow.u('uNebTex'),0); gl.uniform2f(P.glow.u('uRes'),W,H);
  gl.uniform1f(P.glow.u('uStar'),star); gl.uniform1f(P.glow.u('uFlash'),flash);
  gl.uniform1f(P.glow.u('uNeb'),sstep(.5,4,t)*.8); gl.uniform1f(P.glow.u('uRoll'),roll);
  gl.drawArrays(gl.TRIANGLES,0,3);
  gl.useProgram(P.part.p); gl.bindVertexArray(partVao);
  gl.uniformMatrix4fv(P.part.u('uProj'),false,proj); gl.uniformMatrix4fv(P.part.u('uView'),false,view);
  gl.uniform1f(P.part.u('uTime'),t); gl.uniform1f(P.part.u('uPx'),dpr);
  gl.uniform1f(P.part.u('uScale'),(H/2)/Math.tan(FOV/2));
  gl.uniform3fv(P.part.u('uGain'),GAIN_K); gl.uniform3fv(P.part.u('uSizeK'),SIZE_K);
  gl.drawArrays(gl.POINTS,0,N);
  gl.disable(gl.BLEND);

  // bloom (two radii)
  pass(P.bright,T.a1); tex(0,T.scene); gl.uniform1i(P.bright.u('uTex'),0); gl.uniform1f(P.bright.u('uThr'),.8); gl.drawArrays(gl.TRIANGLES,0,3);
  blur(T.a1,T.b1);
  pass(P.bright,T.a2); tex(0,T.a1); gl.uniform1f(P.bright.u('uThr'),0); gl.drawArrays(gl.TRIANGLES,0,3);
  blur(T.a2,T.b2);

  // composite
  pass(P.comp,null);
  tex(0,T.scene); tex(1,T.a1); tex(2,T.a2);
  gl.uniform1i(P.comp.u('uScene'),0); gl.uniform1i(P.comp.u('uB1'),1); gl.uniform1i(P.comp.u('uB2'),2);
  gl.uniform1f(P.comp.u('uExp'),1.0); gl.uniform2f(P.comp.u('uRes'),W,H);
  gl.drawArrays(gl.TRIANGLES,0,3);
}
raf = requestAnimationFrame(frame);

} catch (err) {                                   // shader/GPU problem: fall back to the image
  console.warn('protostar.js disabled:', err);
  canvas.remove(); ctrl.remove(); delete body.dataset.hero; body.classList.remove('protostar-intro');
}
})();