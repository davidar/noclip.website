
precision mediump float;

// Expected to be constant across the entire scene.
layout(row_major, std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    vec4 u_AmbientColor;
};

layout(row_major, std140) uniform ub_MeshFragParams {
    Mat4x3 u_ViewMatrix;
};

uniform sampler2D u_Texture[1];

varying vec4 v_Color;
varying vec2 v_TexCoord;
varying float v_TexFactor;
varying vec4 v_TexScaleOffset;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec4 a_Color;
layout(location = 2) in vec2 a_TexCoord;
layout(location = 3) in float a_TexFactor;
layout(location = 4) in vec4 a_TexScaleOffset;

void main() {
    gl_Position = Mul(u_Projection, Mul(_Mat4x4(u_ViewMatrix), vec4(a_Position, 1.0)));
    v_Color = a_Color;
    v_TexCoord = a_TexCoord;
    v_TexFactor = a_TexFactor;
    v_TexScaleOffset = a_TexScaleOffset;
}
#endif

#ifdef FRAG
void main() {
    vec4 t_Color = vec4(1);

    t_Color *= v_Color;

    t_Color.rgb += u_AmbientColor.rgb;

    t_Color *= v_TexFactor * texture2D(u_Texture[0], fract(v_TexCoord) * v_TexScaleOffset.xy + v_TexScaleOffset.zw);

    if (t_Color.a < 1.0/255.0) discard;

    gl_FragColor = t_Color;
}
#endif
