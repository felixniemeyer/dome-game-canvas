#version 300 es
precision highp float;

layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 aDomePosition;
layout(location = 2) in float aVisibilityAlpha;
layout(location = 3) in vec3 aColor;
layout(location = 4) in float aKind;
layout(location = 5) in float aRadius;
layout(location = 6) in float aPressAlpha;

uniform vec2 uDomeScale;

out vec2 vLocal;
out vec2 vDomemasterLocal;
out float vVisibilityAlpha;
out vec3 vColor;
out float vKind;
out float vPressAlpha;

const float PI = 3.14159265358979323846;
const float halfPI = 0.5 * PI;
const float aroundLengthAtZenit = 1.0;
const float aroundLengthAtHorizon = halfPI;

void main() {
  vLocal = aCorner;
  vDomemasterLocal = aCorner;
  vVisibilityAlpha = aVisibilityAlpha;
  vColor = aColor;
  vKind = aKind;
  vPressAlpha = aPressAlpha;

  float domeRadius = length(aDomePosition);
  vec2 dir = domeRadius > 0.001 ? aDomePosition / domeRadius : vec2(1.0, 0.0);
  float theta = domeRadius * halfPI;
  float normZ = cos(theta);
  vec2 aroundZenit = vec2(dir.y, -dir.x) * mix(aroundLengthAtZenit, aroundLengthAtHorizon, 1.0 - normZ);
  vec2 towardsZenit = dir;
  vec2 domemasterOffset = (aCorner.x * aroundZenit + aCorner.y * towardsZenit) * aRadius;
  vec2 domemasterPosition = aDomePosition + domemasterOffset;
  vec2 screenPosition = vec2(domemasterPosition.x * uDomeScale.x, -domemasterPosition.y * uDomeScale.y);
  gl_Position = vec4(screenPosition, 0.0, 1.0);
}
