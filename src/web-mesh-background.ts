const VERTEX_SHADER = `attribute vec2 a_position;
void main() {
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `// "Mesh drift" — made with the 21st.dev Shader Builder
// Packed WebGL1 uniforms (the shader exposes readable u_* aliases as macros):
//   u_colors[8] (first 4 used)
//   vec3(0.012, 0.071, 0.055)
//   vec3(0.055, 0.486, 0.353)
//   vec3(0.486, 0.898, 0.467)
//   vec3(0.957, 1.000, 0.780)
//   u_scene = vec4(canvas width, canvas height, seconds * 0.73, 4.0)
//   u_shape = vec4(1.16, 0.34, 0.50, 0.00)
//   u_surface = vec4(2.40, 1.16, 0.00, 1.00)
//   u_finish = vec4(0.00, 0.00, 0.000, 0.09)
//   u_transform = vec4(1453.0, 0.00, 0.00, 0.0)
//   u_space = vec4(0.00, 0.00, pointer x, pointer y)
//   u_cursor = vec4(presence, 2.0, 0.65, 0.46)

#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

uniform vec3 u_colors[8];
uniform vec4 u_scene;
uniform vec4 u_shape;
uniform vec4 u_surface;
uniform vec4 u_finish;
uniform vec4 u_transform;
uniform vec4 u_space;
uniform vec4 u_cursor;

#define u_resolution u_scene.xy
#define u_time u_scene.z
#define u_colorCount u_scene.w
#define u_scale u_shape.x
#define u_intensity u_shape.y
#define u_paramA u_shape.z
#define u_warp u_shape.w
#define u_detail u_surface.x
#define u_contrast u_surface.y
#define u_brightness u_surface.z
#define u_saturation u_surface.w
#define u_hue u_finish.x
#define u_vignette u_finish.y
#define u_blur u_finish.z
#define u_grain u_finish.w
#ifdef GL_FRAGMENT_PRECISION_HIGH
#define u_seed u_transform.x
#else
#define u_seed mod(u_transform.x, 31.0)
#endif
#define u_rotate u_transform.y
#define u_drift u_transform.z
#define u_oklab u_transform.w
#define u_offset u_space.xy
#define u_mouse u_space.zw
#define u_cursorPresence u_cursor.x
#define u_cursorEffect u_cursor.y
#define u_cursorStrength u_cursor.z
#define u_cursorRadius u_cursor.w

float hash21(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}

float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
#ifndef GL_FRAGMENT_PRECISION_HIGH
  p = mod(p, 31.0);
#endif
  float n = sin(dot(p, vec2(41.0, 289.0)));
  return fract(vec2(15731.743, 7892.321) * n);
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x),
    u.y);
}

float fbm(vec2 p) {
  float v = 0.0;
  float a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * noise(p);
    p = p * 2.03 + vec2(17.0, 9.2);
    a *= 0.5;
  }
  return v;
}

vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)),
    step(0.04045, c));
}
vec3 linearToSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) - 0.055,
    step(0.0031308, c));
}
vec3 linToOklab(vec3 c) {
  float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
  float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
  float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
  l = pow(max(l, 0.0), 1.0 / 3.0);
  m = pow(max(m, 0.0), 1.0 / 3.0);
  s = pow(max(s, 0.0), 1.0 / 3.0);
  return vec3(
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
vec3 oklabToLin(vec3 c) {
  float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  l = l * l * l; m = m * m * m; s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 mixColour(vec3 a, vec3 b, float t) {
  if (u_oklab > 0.5) {
    vec3 la = linToOklab(srgbToLinear(a));
    vec3 lb = linToOklab(srgbToLinear(b));
    return clamp(linearToSrgb(oklabToLin(mix(la, lb, t))), 0.0, 1.0);
  }
  return mix(a, b, t);
}

vec3 palette(float x) {
  float n = max(u_colorCount - 1.0, 1.0);
  float f = clamp(x, 0.0, 1.0) * n;
  vec3 col = u_colors[0];
  for (int i = 0; i < 7; i++) {
    if (float(i) < n)
      col = mixColour(col, u_colors[i + 1],
        smoothstep(0.0, 1.0, clamp(f - float(i), 0.0, 1.0)));
  }
  return col;
}

vec3 hueRotate(vec3 col, float a) {
  const mat3 toYIQ = mat3(0.299, 0.596, 0.211,
                          0.587, -0.274, -0.523,
                          0.114, -0.322, 0.312);
  const mat3 toRGB = mat3(1.0, 1.0, 1.0,
                          0.956, -0.272, -1.106,
                          0.621, -0.647, 1.703);
  vec3 yiq = toYIQ * col;
  float ca = cos(a), sa = sin(a);
  yiq = vec3(yiq.x, yiq.y * ca - yiq.z * sa, yiq.y * sa + yiq.z * ca);
  return toRGB * yiq;
}

vec3 shade(vec2 uv, vec2 p, float t) {
  vec3 acc = u_colors[0] * 0.15;
  float total = 0.15;
  for (int i = 0; i < 8; i++) {
    if (float(i) >= u_colorCount) break;
    float fi = float(i);
    vec2 c = vec2(
      sin(t * (0.21 + fi * 0.071) + fi * 2.4 + u_seed),
      cos(t * (0.17 + fi * 0.093) + fi * 1.7)) * (0.45 + u_intensity * 0.35);
    float w = exp(-dot(p - c, p - c) * 6.0);
    acc += u_colors[i] * w;
    total += w;
  }
  return acc / total;
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution.xy;
  vec2 screenUv = uv;
  vec2 p = (gl_FragCoord.xy - 0.5 * u_resolution.xy)
    / min(u_resolution.x, u_resolution.y);
  float cursorMask = 0.0;

  if (u_cursorPresence > 0.001) {
    vec2 cursor = (0.5 * u_mouse * u_resolution.xy)
      / min(u_resolution.x, u_resolution.y);
    vec2 cursorDelta = p - cursor;
    if (u_cursorEffect < 0.5) {
      p += cursor * u_cursorPresence * u_cursorStrength * 0.55;
    } else {
      float cursorDistance = length(cursorDelta);
      vec2 cursorDirection = cursorDelta / max(cursorDistance, 0.0001);
      cursorMask = u_cursorPresence
        * (1.0 - smoothstep(0.0, u_cursorRadius, cursorDistance));
      if (u_cursorEffect < 1.5) {
        p -= cursorDirection * cursorMask * u_cursorStrength * 0.24;
      } else if (u_cursorEffect < 2.5) {
        float cursorAngle = cursorMask * u_cursorStrength * 2.2;
        float cc = cos(cursorAngle), cs = sin(cursorAngle);
        p = cursor + mat2(cc, -cs, cs, cc) * cursorDelta;
      } else if (u_cursorEffect < 3.5) {
        float ripple = sin(
          cursorDistance / max(u_cursorRadius, 0.001) * 18.0 - u_time * 5.0);
        p -= cursorDirection * ripple * cursorMask * u_cursorStrength * 0.07;
      }
    }
  }

  uv = p * min(u_resolution.x, u_resolution.y) / u_resolution.xy + 0.5;
  p *= u_scale;
  if (abs(u_rotate) > 0.0001) {
    float cr = cos(u_rotate), sr = sin(u_rotate);
    p = mat2(cr, -sr, sr, cr) * p;
  }
  p += u_offset;
  if (u_drift > 0.0001)
    p += u_drift * vec2(sin(u_time * 0.31), cos(u_time * 0.23));
  if (u_warp > 0.0) {
    p += u_warp * (vec2(
      fbm(p * u_detail + u_seed),
      fbm(p * u_detail + vec2(5.2, 1.3))) - 0.5);
  }
  vec3 col;
  if (u_blur > 0.0) {
    float e = u_blur;
    float pe = e * u_scale;
    vec2 uvE = vec2(e) * min(u_resolution.x, u_resolution.y) / u_resolution.xy;
    col  = shade(uv, p, u_time) * 0.36;
    col += shade(uv + vec2(uvE.x, 0.0), p + vec2(pe, 0.0), u_time) * 0.16;
    col += shade(uv - vec2(uvE.x, 0.0), p - vec2(pe, 0.0), u_time) * 0.16;
    col += shade(uv + vec2(0.0, uvE.y), p + vec2(0.0, pe), u_time) * 0.16;
    col += shade(uv - vec2(0.0, uvE.y), p - vec2(0.0, pe), u_time) * 0.16;
  } else {
    col = shade(uv, p, u_time);
  }
  if (abs(u_contrast - 1.0) > 0.0001)
    col = (col - 0.5) * u_contrast + 0.5;
  if (abs(u_saturation - 1.0) > 0.0001) {
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, u_saturation);
  }
  if (abs(u_hue) > 0.0001)
    col = hueRotate(col, u_hue);
  if (abs(u_brightness) > 0.0001)
    col += u_brightness;
  if (u_vignette > 0.0001) {
    float vd = length(screenUv - 0.5) * 1.41421356;
    col *= 1.0 - u_vignette * smoothstep(0.35, 1.0, vd);
  }
  if (u_cursorPresence > 0.001 && u_cursorEffect > 3.5)
    col += (vec3(0.18) + col * 0.12) * cursorMask * u_cursorStrength;
  if (u_grain > 0.0001)
    col += (grainHash(
      gl_FragCoord.xy + vec2(u_seed * 17.0, u_seed * 31.0)) - 0.5) * u_grain;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

const WEB_BACKGROUND_STYLE = `
html{background:#03120e!important}
body{background:transparent!important;position:relative;isolation:isolate}
body:before{display:none!important}
#meshBackground{position:fixed;inset:0;z-index:0;width:100vw;height:100vh;display:block;pointer-events:none;background:#03120e}
@supports (width:100dvw) and (height:100dvh){#meshBackground{width:100dvw;height:100dvh}}
.page{position:relative;z-index:1}
:root{--glass-line:linear-gradient(118deg,rgba(255,255,255,.46) 0%,rgba(255,255,255,.08) 20%,rgba(255,255,255,.18) 47%,rgba(255,255,255,.055) 74%,rgba(255,255,255,.34) 100%);--glass-line-focus:linear-gradient(118deg,rgba(255,255,255,.64) 0%,rgba(255,255,255,.13) 20%,rgba(255,255,255,.27) 47%,rgba(255,255,255,.09) 74%,rgba(255,255,255,.48) 100%)}
.modeSwitch,.inputShell,.result,.progress,.ready{position:relative;border:1px solid rgba(255,255,255,.095)!important;background:transparent!important;-webkit-backdrop-filter:blur(2.5px);backdrop-filter:blur(2.5px);box-shadow:inset 0 1px 0 rgba(255,255,255,.065),inset 0 -1px 0 rgba(0,0,0,.12),0 16px 44px rgba(0,0,0,.11)!important}
.modeSwitch{background:transparent!important}
.inputShell{transition:transform .2s,box-shadow .2s!important}
.inputShell:focus-within{border-color:rgba(255,255,255,.15)!important;background:transparent!important;transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.09),inset 0 -1px 0 rgba(0,0,0,.15),0 18px 50px rgba(0,0,0,.13)!important}
.linkIcon{background:rgba(0,0,0,.045)!important;border:1px solid rgba(255,255,255,.08)}
.url::placeholder{color:rgba(255,255,255,.44)!important}
.modeButton:not(.active){color:rgba(255,255,255,.54)!important}
.format{background:rgba(0,0,0,.075)!important;border-color:rgba(255,255,255,.115)!important}
.format.selected{background:var(--metallic-white)!important;color:#080808!important;border-color:rgba(255,255,255,.72)!important}
.resultHead{border-bottom-color:rgba(255,255,255,.1)!important}
.playerCard{background:transparent!important}
.watchMeta{color:#fff;text-shadow:0 1px 12px rgba(0,0,0,.32)}
@supports ((-webkit-mask-composite:xor) or (mask-composite:exclude)){
  .modeSwitch::before,.inputShell::before,.result::before,.progress::before,.ready::before{content:"";position:absolute;inset:-1px;border-radius:inherit;padding:1px;background:var(--glass-line);pointer-events:none;z-index:3;-webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);-webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}
  .inputShell:focus-within::before{background:var(--glass-line-focus)}
}
@supports not ((backdrop-filter:blur(2.5px)) or (-webkit-backdrop-filter:blur(2.5px))){.modeSwitch,.inputShell,.result,.progress,.ready{background:rgba(3,18,14,.24)!important}}
`;

function toScriptLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const WEB_BACKGROUND_SCRIPT = `(function(){
var canvas=document.getElementById('meshBackground');
if(!canvas)return;
var gl=canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false});
if(!gl){canvas.style.display='none';return;}
var vertexSource=${toScriptLiteral(VERTEX_SHADER)};
var fragmentSource=${toScriptLiteral(FRAGMENT_SHADER)};
var program=null,buffer=null,locations=null,raf=0,lastFrame=0,activeSeconds=0;
var colors=new Float32Array([
  0.012,0.071,0.055,
  0.055,0.486,0.353,
  0.486,0.898,0.467,
  0.957,1.000,0.780,
  0,0,0,0,0,0,0,0,0,0,0,0
]);
function compile(type,source){
  var shader=gl.createShader(type);if(!shader)throw new Error('WebGL shader allocation failed');
  gl.shaderSource(shader,source);gl.compileShader(shader);
  if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)){var log=gl.getShaderInfoLog(shader)||'WebGL shader compilation failed';gl.deleteShader(shader);throw new Error(log)}
  return shader;
}
function setup(){
  var vs=compile(gl.VERTEX_SHADER,vertexSource),fs=compile(gl.FRAGMENT_SHADER,fragmentSource);
  var next=gl.createProgram();if(!next)throw new Error('WebGL program allocation failed');
  gl.attachShader(next,vs);gl.attachShader(next,fs);gl.linkProgram(next);gl.deleteShader(vs);gl.deleteShader(fs);
  if(!gl.getProgramParameter(next,gl.LINK_STATUS)){var log=gl.getProgramInfoLog(next)||'WebGL program link failed';gl.deleteProgram(next);throw new Error(log)}
  program=next;gl.useProgram(program);
  buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
  var position=gl.getAttribLocation(program,'a_position');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  locations={colors:gl.getUniformLocation(program,'u_colors[0]'),scene:gl.getUniformLocation(program,'u_scene'),shape:gl.getUniformLocation(program,'u_shape'),surface:gl.getUniformLocation(program,'u_surface'),finish:gl.getUniformLocation(program,'u_finish'),transform:gl.getUniformLocation(program,'u_transform'),space:gl.getUniformLocation(program,'u_space'),cursor:gl.getUniformLocation(program,'u_cursor')};
  gl.uniform3fv(locations.colors,colors);
  gl.uniform4f(locations.shape,1.16,0.34,0.50,0.00);
  gl.uniform4f(locations.surface,2.40,1.16,0.00,1.00);
  gl.uniform4f(locations.finish,0.00,0.00,0.000,0.09);
  gl.uniform4f(locations.transform,1453.0,0.00,0.00,0.0);
  gl.uniform4f(locations.space,0.00,0.00,0.00,0.00);
  gl.uniform4f(locations.cursor,0.00,2.0,0.65,0.46);
}
function resize(){
  var rect=canvas.getBoundingClientRect();
  var dpr=Math.min(window.devicePixelRatio||1,2);
  var width=Math.max(1,Math.round(rect.width*dpr));
  var height=Math.max(1,Math.round(rect.height*dpr));
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;gl.viewport(0,0,width,height)}
}
function draw(now){
  raf=0;if(document.hidden||!program)return;
  if(lastFrame)activeSeconds+=(now-lastFrame)/1000;lastFrame=now;
  resize();gl.useProgram(program);
  gl.uniform4f(locations.scene,canvas.width,canvas.height,activeSeconds*0.73,4.0);
  gl.drawArrays(gl.TRIANGLES,0,3);
  raf=requestAnimationFrame(draw);
}
function start(){if(document.hidden||raf||!program)return;lastFrame=0;raf=requestAnimationFrame(draw)}
function stop(){if(raf){cancelAnimationFrame(raf);raf=0}lastFrame=0}
try{setup();resize();start()}catch(error){console.error('Mesh background:',error);canvas.style.display='none';return}
window.addEventListener('resize',resize,{passive:true});
window.addEventListener('orientationchange',resize,{passive:true});
if(window.visualViewport)window.visualViewport.addEventListener('resize',resize,{passive:true});
document.addEventListener('visibilitychange',function(){if(document.hidden)stop();else{resize();start()}});
canvas.addEventListener('webglcontextlost',function(event){event.preventDefault();stop()});
canvas.addEventListener('webglcontextrestored',function(){try{setup();resize();start()}catch(error){console.error('Mesh background restore:',error);canvas.style.display='none'}});
})();`;

export function applyWebBackground(response: Response): Response {
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(`<style>${WEB_BACKGROUND_STYLE}</style>`, { html: true });
      },
    })
    .on("body", {
      element(element) {
        element.prepend('<canvas id="meshBackground" aria-hidden="true"></canvas>', { html: true });
        element.append(`<script>${WEB_BACKGROUND_SCRIPT}</script>`, { html: true });
      },
    })
    .transform(response);
}
