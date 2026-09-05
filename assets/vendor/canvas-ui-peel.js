// Canvas UI Peel — Copyright (c) 2026 David Haz.
// Source: https://github.com/DavidHDev/canvas-ui/blob/8aec65707b298a227472c117b892b5695955216c/src/lib/Peel/PeelVanilla.ts
// License: ./canvas-ui-LICENSE.md (MIT + Commons Clause).
// Reader adaptation: upstream curl mesh/shaders, explicit progress, snapshot input,
// checked GPU failures and deterministic cleanup. No hover listeners or idle loop.
const SHEET_VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aGrid;
uniform vec2 uRes;
uniform float uSide;
uniform float uPeel;
uniform float uReveal;
uniform float uCurl;
uniform float uBow;
uniform float uFocal;
uniform float uZone;
uniform float uBulge;
uniform vec2 uPointer;
out vec2 vUv;
out float vShade;
out vec2 vSide;

const float PI = 3.1415926;

void main () {
  vUv = aGrid;
  vec2 p = aGrid * uRes;
  float crossLen = (uSide < 1.5) ? uRes.y : uRes.x;
  float u; float v;
  if (uSide < 0.5) { u = p.x; v = p.y; }
  else if (uSide < 1.5) { u = uRes.x - p.x; v = p.y; }
  else if (uSide < 2.5) { u = p.y; v = p.x; }
  else { u = uRes.y - p.y; v = p.x; }

  float A = clamp(uPeel, 0.0, 1.0);
  float f = A * uReveal;
  float R = max(uCurl * A, 0.001);
  float c0 = f + R;

  float dvB = (uPointer.y - v) / max(crossLen * 0.28, 1.0);
  float prox = clamp(1.0 - uPointer.x / max(c0 + uZone, 1.0), 0.0, 1.0);
  float c = c0 + uBulge * A * prox * prox * exp(-dvB * dvB);

  float x = u;
  float z = 0.0;
  float sh = 0.0;
  if (A > 0.001 && u < c) {
    float theta = (c - u) / R;
    if (theta <= PI) {
      x = c - R * sin(theta);
      z = R * (1.0 - cos(theta));
    } else {
      x = c + (theta - PI) * R;
      z = 2.0 * R;
    }
    sh = sin(clamp(theta, 0.0, PI));
  }
  z += uBow * A * sin(PI * v / max(crossLen, 1.0)) * clamp(z / max(R, 1.0), 0.0, 1.5);
  z = clamp(z, -uFocal * 0.2, uFocal * 0.45);
  vShade = sh * smoothstep(0.0, 0.08, A);
  vSide = vec2(u, v);

  vec2 q;
  if (uSide < 0.5) q = vec2(x, v);
  else if (uSide < 1.5) q = vec2(uRes.x - x, v);
  else if (uSide < 2.5) q = vec2(v, x);
  else q = vec2(v, uRes.y - x);

  vec2 ndc = (q / uRes) * 2.0 - 1.0;
  ndc.y = -ndc.y;
  float w = (uFocal - z) / uFocal;
  gl_Position = vec4(ndc, -z / uFocal, w);
}`;

const SHEET_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in float vShade;
in vec2 vSide;
out vec4 outColor;
uniform sampler2D uContent;
uniform float uShade;
uniform float uMaxX;
uniform float uShine;
uniform vec3 uShineColor;
uniform float uCross;
uniform float uSpan;
uniform vec2 uPointer;

void main () {
  vec2 uv = clamp(vUv, vec2(0.001), vec2(uMaxX - 0.001, 0.999));
  vec4 tex = texture(uContent, uv);
  float sh = 1.0 - clamp(uShade, 0.0, 1.0) * 0.7 * pow(max(vShade, 0.0), 1.3);
  float du = max(vSide.x, 0.0);
  float line = exp(-du / 2.5) + exp(-du / 18.0) * 0.25;
  float dv = (vSide.y - uPointer.y) / max(uCross * 0.45, 1.0);
  float prox = clamp(1.0 - uPointer.x / max(uSpan, 1.0), 0.0, 1.0);
  float shine = uShine * line * exp(-dv * dv) * prox * prox;
  vec3 rgb = mix(tex.rgb * sh, uShineColor, clamp(shine, 0.0, 1.0));
  outColor = vec4(rgb * tex.a, tex.a);
}`;

export function createPeel(output) {
  const gl = output.getContext('webgl2', {alpha: true, depth: true, antialias: true, premultipliedAlpha: true});
  if (!gl || gl.isContextLost()) throw new Error('Peel requires WebGL2');
  const resources = [];
  const own = (type, value) => { if (!value) throw new Error('Peel GPU allocation failed'); resources.push([type,value]); return value; };
  const destroy = () => { for (const [type,value] of resources) gl[`delete${type}`](value); resources.length = 0; };
  try {
    const compile = (type, source) => {
      const shader = own('Shader', gl.createShader(type));
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = own('Program', gl.createProgram());
    gl.attachShader(program, compile(gl.VERTEX_SHADER, SHEET_VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, SHEET_FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const uniforms = {};
    for (let i=0; i<gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i++) {
      const info = gl.getActiveUniform(program,i);
      uniforms[info.name] = gl.getUniformLocation(program,info.name);
    }
    const SEG=96, vertices=new Float32Array((SEG+1)*(SEG+1)*2), indices=new Uint32Array(SEG*SEG*6);
    for (let y=0;y<=SEG;y++) for(let x=0;x<=SEG;x++) {
      const i=(y*(SEG+1)+x)*2; vertices[i]=x/SEG; vertices[i+1]=y/SEG;
    }
    let offset=0;
    for (let y=0;y<SEG;y++) for(let x=0;x<SEG;x++) {
      const a=y*(SEG+1)+x,b=a+1,c=a+SEG+1,d=c+1;
      for(const index of [a,c,b,b,c,d]) indices[offset++]=index;
    }
    const vao=own('VertexArray',gl.createVertexArray()); gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER,own('Buffer',gl.createBuffer()));
    gl.bufferData(gl.ARRAY_BUFFER,vertices,gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,own('Buffer',gl.createBuffer()));
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);
    const texture=own('Texture',gl.createTexture()); gl.bindTexture(gl.TEXTURE_2D,texture);
    for(const parameter of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D,parameter,gl.LINEAR);
    for(const parameter of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D,parameter,gl.CLAMP_TO_EDGE);
    let width=1,height=1,side=1;
    return {
      setPage(snapshot,w,h,direction) {
        if(gl.isContextLost()) throw new Error('Peel context lost');
        width=w; height=h; side=direction>0?1:0;
        output.width=snapshot.width; output.height=snapshot.height;
        gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,snapshot);
        if(gl.getError()!==gl.NO_ERROR) throw new Error('Peel texture upload failed');
      },
      render(progress) {
        if(gl.isContextLost()) throw new Error('Peel context lost');
        gl.viewport(0,0,output.width,output.height);
        gl.clearColor(0,0,0,0); gl.clearDepth(1); gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND); gl.blendFunc(gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL);
        gl.useProgram(program); gl.bindVertexArray(vao);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.uniform1i(uniforms.uContent,0); gl.uniform2f(uniforms.uRes,width,height);
        const values={uSide:side,uPeel:progress,uReveal:width*1.25,uCurl:width*.12,uBow:height*.025,uFocal:Math.max(1800,width*3),uZone:width,uBulge:0,uShade:.28,uShine:.1,uCross:height,uSpan:width,uMaxX:1};
        for(const [name,value] of Object.entries(values)) gl.uniform1f(uniforms[name],value);
        gl.uniform3f(uniforms.uShineColor,1,1,1); gl.uniform2f(uniforms.uPointer,0,height*.55);
        gl.drawElements(gl.TRIANGLES,indices.length,gl.UNSIGNED_INT,0);
      },
      destroy
    };
  } catch(error) { destroy(); throw error; }
}
