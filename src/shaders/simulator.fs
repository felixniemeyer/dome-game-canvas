#version 300 es

precision highp float; 

uniform highp sampler2D tex;

uniform mat3 rotation; 

uniform vec2 norm; 

const float PI = 3.14159265358979323846; 
const float mapTheta = 2. / PI; 

in vec2 xy;

out vec4 rgba;

void main() {
  vec3 look = vec3(xy * norm, 1.0); 
  look = normalize(look); 
  look = rotation * look;

  if(look.y < 0.) {
    rgba.rgba = vec4(vec3(0.1 + look.y), 0.1); 
  } else {
    float theta = acos(look.y) * mapTheta; // 0 for zenit, 1 for horizon
    vec2 dir = -normalize(look.xz); 
    vec2 uv = theta * dir * 0.5 + 0.5; 
    rgba.rgba = texture(tex, uv); 
  }
}

