
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
vec4 textureAtlas(sampler2D atlas, vec2 uv, int lod) {
    ivec2 xy = ivec2(v_TexLocation.xy + v_TexLocation.zw * fract(uv));
    return texelFetch(atlas, xy >> lod, lod);
}

// need to do interpolation manually on atlas to avoid bleeding/seams
// https://www.iquilezles.org/www/articles/hwinterpolation/hwinterpolation.htm
vec4 textureAtlasBilinear(sampler2D atlas, vec2 uv, int lod) {
    vec2 res = v_TexLocation.zw / pow(2.0, float(lod));
    vec2 st = uv * res - 0.5;
    vec2 iuv = floor(st);
    vec2 fuv = fract(st);
    vec4 a = textureAtlas(atlas, (iuv + vec2(0.5,0.5)) / res, lod);
    vec4 b = textureAtlas(atlas, (iuv + vec2(1.5,0.5)) / res, lod);
    vec4 c = textureAtlas(atlas, (iuv + vec2(0.5,1.5)) / res, lod);
    vec4 d = textureAtlas(atlas, (iuv + vec2(1.5,1.5)) / res, lod);
    return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}

float mip_map_level(in vec2 texture_coordinate) {
    // The OpenGL Graphics System: A Specification 4.2 - chapter 3.9.11, equation 3.21
    vec2  dx_vtc        = dFdx(texture_coordinate);
    vec2  dy_vtc        = dFdy(texture_coordinate);
    float delta_max_sqr = max(dot(dx_vtc, dx_vtc), dot(dy_vtc, dy_vtc));
    return 0.5 * log2(delta_max_sqr);
}

vec4 textureAtlasTrilinear(sampler2D atlas, vec2 uv) {
    float lod = clamp(mip_map_level(uv * v_TexLocation.zw), 0.0, 6.0);
    vec4 a = textureAtlasBilinear(atlas, uv, int(floor(lod)));
    vec4 b = textureAtlasBilinear(atlas, uv, int(ceil(lod)));
    return mix(a, b, fract(lod));
}

void main() {
    vec4 t_Color = v_Color;
    t_Color.rgb += u_AmbientColor.rgb;
    if (v_TexLocation.w > 0.0)
        t_Color *= textureAtlasTrilinear(u_Texture[0], v_TexCoord);
    if (alphaThreshold >= 0.0 ? t_Color.a < alphaThreshold : t_Color.a >= -alphaThreshold) discard;
    gl_FragColor = t_Color;
}
#endif
