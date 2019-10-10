
precision mediump float;

// Expected to be constant across the entire scene.
layout(row_major, std140) uniform ub_SceneParams {
    Mat4x4 u_Projection;
    vec4 u_AmbientColor;
};

layout(row_major, std140) uniform ub_MeshFragParams {
    Mat4x3 u_ViewMatrix;
    float alphaThreshold;
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
    ivec2 xy = ivec2(v_TexLocation.xy + v_TexLocation.zw * fract(uv));
    return texelFetch(atlas, xy, 0);
}

// need to do interpolation manually on atlas to avoid bleeding/seams
// https://www.iquilezles.org/www/articles/hwinterpolation/hwinterpolation.htm
vec4 textureAtlasBilinear(sampler2D atlas, vec2 uv) {
    vec2 res = v_TexLocation.zw;
    vec2 st = uv * res - 0.5;
    vec2 iuv = floor(st);
    vec2 fuv = fract(st);
    vec4 a = textureAtlas(atlas, (iuv + vec2(0.5,0.5)) / res);
    vec4 b = textureAtlas(atlas, (iuv + vec2(1.5,0.5)) / res);
    vec4 c = textureAtlas(atlas, (iuv + vec2(0.5,1.5)) / res);
    vec4 d = textureAtlas(atlas, (iuv + vec2(1.5,1.5)) / res);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}

void main() {
    vec4 t_Color = v_Color;
    t_Color.rgb += u_AmbientColor.rgb;
    if (v_TexLocation.w > 0.0)
        t_Color *= textureAtlasBilinear(u_Texture[0], v_TexCoord);
    if (alphaThreshold >= 0.0 ? t_Color.a < alphaThreshold : t_Color.a >= -alphaThreshold) discard;
    gl_FragColor = t_Color;
}
#endif
