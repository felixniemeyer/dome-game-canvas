#version 300 es
precision highp float;

in vec2 vLocal;
in vec2 vDomemasterLocal;
in float vVisibilityAlpha;
in float vPressAlpha;
in vec3 vColor;
in float vKind;

uniform float uTime;

out vec4 fragColor;

float cursorAlpha(vec2 uv, float accelerate, float time) {
  float radius = length(uv);
  float angle = atan(uv.y, uv.x);
  float extent = mix(0.2, 0.5, accelerate);
  float edge = 0.035;
  float body = smoothstep(extent, extent - edge, radius);
  float phase = angle * 3.0 + radius * 14.0 + time * 16.0;
  float spiralGate = smoothstep(-0.58, 0.48, cos(phase) + (1.0 - accelerate) * 1.6);
  return body * spiralGate;
}

void main() {
  float radius = length(vDomemasterLocal);
  if (radius > 1.0) {
    discard;
  }

  if (vKind > 0.5) {
    vec2 p = abs(vLocal);
    float outerLine = min(p.x, p.y);
    float outer = 1.0 - smoothstep(0.105, 0.125, outerLine);
    float inner = 1.0 - smoothstep(0.055, 0.075, outerLine);
    float endMask = 1.0 - smoothstep(0.92, 1.0, max(p.x, p.y));
    float alpha = outer * endMask;
    if (alpha <= 0.001) {
      discard;
    }
    vec3 color = mix(vec3(0.0), vec3(1.0), inner);
    fragColor = vec4(color, alpha);
    return;
  }

  float alpha = cursorAlpha(vDomemasterLocal, vPressAlpha, uTime) * vVisibilityAlpha;
  vec3 color = mix(vec3(1.0), vColor, 0.82);
  fragColor = vec4(color, alpha);
}
