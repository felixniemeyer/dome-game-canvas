#version 300 es

precision highp float; 

layout(location=0) in vec2 vertex;

out vec2 xy; 

void main() {
  xy = vertex;
  gl_Position = vec4(vertex, 1, 1);
}
