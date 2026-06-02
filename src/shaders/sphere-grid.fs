#version 300 es
precision highp float;

// Fisheye (domemaster) ray per pixel, then sphere-trace a repeating grid of
// spheres. Each grid cell hashes to one of `beatsPerBar` beats and flashes when
// that beat passes: pulse = (1 + e) / (secondsSinceBeat + e).

uniform vec3 eyePos;
uniform mat3 rotation;

uniform float cellSize;
uniform float sphereRadius;
uniform int marchSteps;
uniform float maxDistance;

uniform vec3 baseColor;
uniform vec3 blinkColor;
uniform float blinkEpsilon;

uniform float barPhase;       // [0,1) position within the current bar
uniform int beatsPerBar;      // beats per bar (cells hash into this many beats)
uniform float secondsPerBar;  // bar duration in seconds (for the pulse decay)

in vec2 xy;
layout(location = 0) out vec4 rgba;

const float PI = 3.14159265358979323846;
const float halfPI = 0.5 * PI;
const float hitEpsilon = 0.0015;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

// repeating sphere lattice
float sdf(vec3 p) {
  vec3 q = p - cellSize * round(p / cellSize);
  return length(q) - sphereRadius;
}

vec3 calcNormal(vec3 p) {
  const float h = 0.0005;
  const vec2 k = vec2(1.0, -1.0);
  vec3 n =
    k.xyy * sdf(p + k.xyy * h) +
    k.yyx * sdf(p + k.yyx * h) +
    k.yxy * sdf(p + k.yxy * h) +
    k.xxx * sdf(p + k.xxx * h);
  return dot(n, n) > 1e-12 ? normalize(n) : vec3(0.0, 0.0, 1.0);
}

// brightness multiplier for the cell a hit belongs to
float beatPulse(vec3 hitPos) {
  vec3 cellId = round(hitPos / cellSize);
  int beats = max(beatsPerBar, 1);
  float beatIndex = floor(hash13(cellId) * float(beats));
  float beatStart = beatIndex / float(beats);
  // bar fraction elapsed since this cell's beat last fired (wraps over the bar)
  float sinceBars = fract(barPhase - beatStart);
  float sinceSeconds = sinceBars * max(secondsPerBar, 1e-3);
  float e = max(blinkEpsilon, 1e-4);
  return (1.0 + e) / (sinceSeconds + e);
}

void main() {
  float l = length(xy);
  if (l > 1.0) {
    discard; // outside the dome disc
  }

  vec2 dirXy = l > 1e-6 ? xy / l : vec2(0.0);
  float angle = l * halfPI;          // l in [0,1] -> 0..90deg => 180deg fisheye
  vec3 dir = rotation * vec3(dirXy * sin(angle), cos(angle));

  vec3 pos = eyePos;
  float t = 0.0;
  float d = maxDistance;
  for (int i = 0; i < marchSteps; i++) {
    d = sdf(pos);
    if (d < hitEpsilon) break;
    t += d;
    pos += dir * d;
    if (t > maxDistance) break;
  }

  if (d >= hitEpsilon) {
    rgba = vec4(0.0); // ray miss -> transparent / black dome
    return;
  }

  vec3 normal = calcNormal(pos);
  vec3 lightDir = normalize(vec3(0.4, 0.7, 0.55));
  float diffuse = max(dot(normal, lightDir), 0.0);
  float rim = pow(1.0 - max(dot(normal, -dir), 0.0), 2.0);

  float pulse = beatPulse(pos);

  vec3 color = baseColor * (0.12 + 0.7 * diffuse + 0.18 * rim);
  color += blinkColor * pulse;

  rgba = vec4(color, 1.0);
}
