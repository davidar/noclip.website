
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
varying vec4 v_TexLocation;

#ifdef VERT
layout(location = 0) in vec3 a_Position;
layout(location = 1) in vec4 a_Color;
layout(location = 2) in vec2 a_TexCoord;
layout(location = 3) in vec4 a_TexLocation;

void main() {
    gl_Position = Mul(u_Projection, Mul(_Mat4x4(u_ViewMatrix), vec4(a_Position, 1.0)));
    v_Color = a_Color;
    v_TexCoord = a_TexCoord;
    v_TexLocation = a_TexLocation;
}
#endif

#ifdef FRAG
vec4 textureAtlas(sampler2D atlas, vec2 uv) {
    vec2 xy = 0.5 + v_TexLocation.xy + (v_TexLocation.zw - 1.0) * fract(uv);
    ivec2 res = textureSize(atlas, 0);
    return texture2D(atlas, xy / vec2(res));
}

void main() {
    vec4 t_Color = vec4(1);

    t_Color *= v_Color;

    t_Color.rgb += u_AmbientColor.rgb;

    if (v_TexLocation.w > 0.0)
        t_Color *= textureAtlas(u_Texture[0], v_TexCoord);

    if (t_Color.a < 1.0/255.0) discard;

    gl_FragColor = t_Color;
}
#endif
