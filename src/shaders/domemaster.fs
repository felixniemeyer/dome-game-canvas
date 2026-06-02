#version 300 es

precision highp float;

uniform highp sampler2D tex;

in vec2 uv;

out vec4 rgba; 

void main() {
  rgba = texture(tex, uv);
}
