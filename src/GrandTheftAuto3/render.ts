
import * as UI from "../ui";
import * as Viewer from "../viewer";
import * as rw from "librw";
// @ts-ignore
import { readFileSync } from "fs";
import { TextureHolder, LoadedTexture, TextureMapping, TextureBase } from "../TextureHolder";
import { GfxDevice, GfxFormat, GfxBufferUsage, GfxBuffer, GfxVertexAttributeDescriptor, GfxVertexAttributeFrequency, GfxInputLayout, GfxInputState, GfxVertexBufferDescriptor, GfxBindingLayoutDescriptor, GfxProgram, GfxHostAccessPass, GfxSampler, GfxTexFilterMode, GfxMipFilterMode, GfxWrapMode, GfxTextureDimension, GfxRenderPass, GfxMegaStateDescriptor, GfxBlendMode, GfxBlendFactor, GfxTexture } from "../gfx/platform/GfxPlatform";
import { makeStaticDataBuffer, makeStaticDataBufferFromSlice } from "../gfx/helpers/BufferHelpers";
import { DeviceProgram } from "../Program";
import { convertToTriangleIndexBuffer, filterDegenerateTriangleIndexBuffer, GfxTopology } from "../gfx/helpers/TopologyHelpers";
import { fillMatrix4x3, fillMatrix4x4, fillColor, fillVec4v, fillVec3 } from "../gfx/helpers/UniformBufferHelpers";
import { mat4, quat, vec4, vec3, vec2 } from "gl-matrix";
import { computeViewMatrix, Camera } from "../Camera";
import ArrayBufferSlice from "../ArrayBufferSlice";
import { GfxRenderHelper } from "../gfx/render/GfxRenderGraph";
import { nArray, assertExists, assert } from "../util";
import { BasicRenderTarget, makeClearRenderPassDescriptor } from "../gfx/helpers/RenderTargetHelpers";
import { GfxRenderInstManager, GfxRendererLayer, makeSortKey } from "../gfx/render/GfxRenderer";
import { ItemInstance, ObjectDefinition, ObjectFlags } from "./item";
import { Color, colorNew, White, colorNewCopy, colorLerp, colorMult } from "../Color";
import { ColorSet } from "./time";
import { AABB } from "../Geometry";

const TIME_FACTOR = 2500; // one day cycle per minute

export class Texture implements TextureBase {
    public name: string;
    public width: number;
    public height: number;
    public depth: number;
    public pixels: Uint8Array;

    constructor(texture: rw.Texture, txdName: string) {
        this.name = txdName + '/' + texture.name.toLowerCase();
        const image = texture.raster.toImage();
        image.unindex();
        this.width = image.width;
        this.height = image.height;
        this.depth = image.depth;
        this.pixels = image.pixels!.slice();
        image.delete();
    }
}

export class TextureAtlas extends TextureMapping {
    public subimages = new Map<string, vec4>(); // name => x offset, y offset, width, height

    constructor(device: GfxDevice, textures: Texture[]) {
        super();
        let area = 0;
        for (const texture of textures) {
            area += texture.width * texture.height;
        }
        assert(textures.length > 0);

        // Greedily place textures in order of decreasing height into row bins.
        textures.sort(function(a,b) {
            if (a.height === b.height) {
                if (a.width === b.width) {
                    return a.name < b.name ? 1 : -1;
                }
                return a.width < b.width ? 1 : -1;
            }
            return a.height < b.height ? 1 : -1;
        });
        const atlasWidth = Math.min(2048, 1 << Math.ceil(Math.log(Math.sqrt(area)) / Math.log(2)));
        let atlasHeight = textures[0].height;
        let ax = 0;
        let ay = 0;
        for (const texture of textures) {
            if (texture.width > atlasWidth - ax) {
                ax = 0;
                ay = atlasHeight;
                atlasHeight += texture.height;
            }
            this.subimages.set(texture.name, vec4.fromValues(ax, ay, texture.width, texture.height));
            ax += texture.width;
        }

        console.log('Creating', atlasWidth, 'x', atlasHeight, 'atlas from', textures.length, 'textures');

        // Finalize texture atlas after placing all textures.
        const pixels = new Uint8Array(atlasWidth * atlasHeight * 4);
        for (const texture of textures) {
            const [atlasX, atlasY] = this.subimages.get(texture.name)!;
            for (let y = 0; y < texture.height; y++) {
                for (let x = 0; x < texture.width; x++) {
                    const srcOffs = (y * texture.width + x) * (texture.depth / 8);
                    const atlasOffs = ((y + atlasY) * atlasWidth + x + atlasX) * 4;
                    pixels[atlasOffs] = texture.pixels[srcOffs];
                    pixels[atlasOffs + 1] = texture.pixels[srcOffs + 1];
                    pixels[atlasOffs + 2] = texture.pixels[srcOffs + 2];
                    if (texture.depth === 32) {
                        pixels[atlasOffs + 3] = texture.pixels[srcOffs + 3];
                    } else {
                        pixels[atlasOffs + 3] = 0xff;
                    }
                }
            }
        }
        const gfxTexture = device.createTexture({
            dimension: GfxTextureDimension.n2D, pixelFormat: GfxFormat.U8_RGBA,
            width: atlasWidth, height: atlasHeight, depth: 1, numLevels: 1
        });
        device.setResourceName(gfxTexture, `textureAtlas`);
        const hostAccessPass = device.createHostAccessPass();
        hostAccessPass.uploadTextureData(gfxTexture, 0, [pixels]);
        device.submitPass(hostAccessPass);

        this.gfxTexture = gfxTexture;
        this.width = atlasWidth;
        this.height = atlasHeight;
        this.flipY = false;

        this.gfxSampler = device.createSampler({
            magFilter: GfxTexFilterMode.POINT,
            minFilter: GfxTexFilterMode.POINT,
            mipFilter: GfxMipFilterMode.NO_MIP,
            minLOD: 0,
            maxLOD: 1000,
            wrapS: GfxWrapMode.CLAMP,
            wrapT: GfxWrapMode.CLAMP,
        });
    }

    public destroy(device: GfxDevice): void {
        if (this.gfxSampler !== null)
            device.destroySampler(this.gfxSampler);
    }
}

class GTA3Program extends DeviceProgram {
    public static a_Position = 0;
    public static a_Color = 1;
    public static a_TexCoord = 2;
    public static a_TexLocation = 3;

    public static ub_SceneParams = 0;
    public static ub_MeshFragParams = 1;

    private static program = readFileSync('src/GrandTheftAuto3/program.glsl', { encoding: 'utf8' });
    public both = GTA3Program.program;
}

interface VertexAttributes {
    position: vec3;
    normal: vec3;
    texCoord: vec2;
    color: Color;
}
class MeshFragData {
    public vertices: VertexAttributes[] = [];
    public indices: Uint16Array;
    public texName?: string;

    constructor(mesh: rw.Mesh, tristrip: boolean, txdName: string, positions: Float32Array, normals: Float32Array | null, texCoords: Float32Array | null, colors: Uint8Array | null) {
        const texture = mesh.material.texture;
        if (texture)
            this.texName = txdName + '/' + texture.name.toLowerCase();

        let baseColor = colorNewCopy(White);
        const col = mesh.material.color;
        if (col)
            baseColor = colorNew(col[0] / 0xFF, col[1] / 0xFF, col[2] / 0xFF, col[3] / 0xFF);

        const indexMap = Array.from(new Set(mesh.indices)).sort();
        for (const i of indexMap) {
            const vertex: VertexAttributes = {
                position: vec3.fromValues(positions[3*i+0], positions[3*i+1], positions[3*i+2]),
                normal: vec3.create(),
                texCoord: vec2.create(),
                color: colorNewCopy(baseColor)
            };
            if (normals !== null)
                vertex.normal = vec3.fromValues(normals[3*i+0], normals[3*i+1], normals[3*i+2]);
            if (texCoords !== null)
                vertex.texCoord = vec2.fromValues(texCoords[2*i+0], texCoords[2*i+1]);
            if (colors !== null)
                colorMult(vertex.color, vertex.color, colorNew(colors[4*i+0]/0xFF, colors[4*i+1]/0xFF, colors[4*i+2]/0xFF, colors[4*i+3]/0xFF));
            this.vertices.push(vertex);
        }

        this.indices = filterDegenerateTriangleIndexBuffer(convertToTriangleIndexBuffer(
            tristrip ? GfxTopology.TRISTRIP : GfxTopology.TRIANGLES,
            mesh.indices!.map(index => indexMap.indexOf(index))));
    }
}

class MeshData {
    public meshFragData: MeshFragData[] = [];

    constructor(atomic: rw.Atomic, public obj: ObjectDefinition) {
        const geom = atomic.geometry;

        const positions = geom.morphTarget(0).vertices!;
        const normals = geom.morphTarget(0).normals;
        const texCoords = (geom.numTexCoordSets > 0) ? geom.texCoords(0) : null;
        const colors = geom.colors;

        let h = geom.meshHeader;
        for (let i = 0; i < h.numMeshes; i++) {
            const frag = new MeshFragData(h.mesh(i), h.tristrip, obj.txdName, positions, normals, texCoords, colors);
            this.meshFragData.push(frag);
        }
    }
}

class ModelCache {
    public meshData = new Map<string, MeshData>();

    public addModel(model: rw.Clump, obj: ObjectDefinition) {
        let node: rw.Atomic | null = null;
        for (let lnk = model.atomics.begin; !lnk.is(model.atomics.end); lnk = lnk.next) {
            const atomic = rw.Atomic.fromClump(lnk);
            const atomicName = atomic.frame.name.toLowerCase();
            if (node === null || atomicName.endsWith('_l0')) {
                // only use the unbroken variant of breakable objects
                node = atomic;
            }
        }
        if (node !== null)
            this.meshData.set(obj.modelName, new MeshData(node, obj));
    }
}

export class MeshInstance {
    public modelMatrix = mat4.create();

    constructor(public meshData: MeshData, public item: ItemInstance) {
        mat4.fromRotationTranslationScale(this.modelMatrix, this.item.rotation, this.item.translation, this.item.scale);
        // convert Z-up to Y-up
        mat4.multiply(this.modelMatrix, mat4.fromQuat(mat4.create(), quat.fromValues(0.5, 0.5, 0.5, -0.5)), this.modelMatrix);
    }
}

export interface MapLayerKey {
    zone: string;
    renderLayer: GfxRendererLayer;
    drawDistance?: number;
    timeOn?: number;
    timeOff?: number;
}

const LAYER_SHADOWS = GfxRendererLayer.TRANSLUCENT + 1;
const LAYER_TREES   = GfxRendererLayer.TRANSLUCENT + 2;

export class MapLayer {
    public bbox = new AABB();

    private vertexBuffer: GfxBuffer;
    private indexBuffer: GfxBuffer;
    private inputLayout: GfxInputLayout;
    private inputState: GfxInputState;

    private vertices = 0;
    private indices = 0;

    private program = new GTA3Program();

    private gfxProgram: GfxProgram | null = null;
    private megaStateFlags: Partial<GfxMegaStateDescriptor> = {
        blendMode: GfxBlendMode.ADD,
        blendDstFactor: GfxBlendFactor.ONE_MINUS_SRC_ALPHA,
        blendSrcFactor: GfxBlendFactor.SRC_ALPHA,
    };

    constructor(device: GfxDevice, public key: MapLayerKey, meshes: MeshInstance[], private atlas?: TextureAtlas) {
        if (key.renderLayer === LAYER_SHADOWS) this.megaStateFlags.depthWrite = false;

        for (const inst of meshes) {
            for (const frag of inst.meshData.meshFragData) {
                this.vertices += frag.vertices.length;
                this.indices += frag.indices.length;
            }
        }

        const points = [] as vec3[];
        const vbuf = new Float32Array(this.vertices * 13);
        const ibuf = new Uint32Array(this.indices);
        let voffs = 0;
        let ioffs = 0;
        let lastIndex = 0;
        for (const inst of meshes) {
            for (const frag of inst.meshData.meshFragData) {
                const texLocation = (frag.texName === undefined || atlas === undefined) ? undefined : atlas.subimages.get(frag.texName);
                for (const vertex of frag.vertices) {
                    const pos = vec3.transformMat4(vec3.create(), vertex.position, inst.modelMatrix);
                    points.push(pos);
                    vbuf[voffs++] = pos[0];
                    vbuf[voffs++] = pos[1];
                    vbuf[voffs++] = pos[2];
                    voffs += fillColor(vbuf, voffs, vertex.color);
                    vbuf[voffs++] = vertex.texCoord[0];
                    vbuf[voffs++] = vertex.texCoord[1];
                    if (texLocation === undefined) {
                        voffs += fillVec4v(vbuf, voffs, vec4.fromValues(-1,-1,-1,-1));
                    } else {
                        voffs += fillVec4v(vbuf, voffs, texLocation);
                    }
                }
                for (const index of frag.indices) {
                    ibuf[ioffs++] = index + lastIndex;
                }
                lastIndex += frag.vertices.length;
            }
        }

        this.bbox.set(points);
        this.vertexBuffer = makeStaticDataBuffer(device, GfxBufferUsage.VERTEX, vbuf.buffer);
        this.indexBuffer  = makeStaticDataBuffer(device, GfxBufferUsage.INDEX,  ibuf.buffer);

        const vertexAttributeDescriptors: GfxVertexAttributeDescriptor[] = [
            { location: GTA3Program.a_Position,    bufferIndex: 0, format: GfxFormat.F32_RGB,  bufferByteOffset: 0 * 0x04, frequency: GfxVertexAttributeFrequency.PER_VERTEX },
            { location: GTA3Program.a_Color,       bufferIndex: 0, format: GfxFormat.F32_RGBA, bufferByteOffset: 3 * 0x04, frequency: GfxVertexAttributeFrequency.PER_VERTEX },
            { location: GTA3Program.a_TexCoord,    bufferIndex: 0, format: GfxFormat.F32_RG,   bufferByteOffset: 7 * 0x04, frequency: GfxVertexAttributeFrequency.PER_VERTEX },
            { location: GTA3Program.a_TexLocation, bufferIndex: 0, format: GfxFormat.F32_RGBA, bufferByteOffset: 9 * 0x04, frequency: GfxVertexAttributeFrequency.PER_VERTEX },
        ];
        this.inputLayout = device.createInputLayout({ indexBufferFormat: GfxFormat.U32_R, vertexAttributeDescriptors });
        const buffers = [{ buffer: this.vertexBuffer, byteOffset: 0, byteStride: 13 * 0x04}];
        const indexBuffer = { buffer: this.indexBuffer, byteOffset: 0, byteStride: 0 };
        this.inputState = device.createInputState(this.inputLayout, buffers, indexBuffer);
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewRenderer: Viewer.ViewerRenderInput) {
        const renderInst = renderInstManager.pushRenderInst();
        renderInst.setInputLayoutAndState(this.inputLayout, this.inputState);
        renderInst.drawIndexes(this.indices);

        if (this.gfxProgram === null)
            this.gfxProgram = renderInstManager.gfxRenderCache.createProgram(device, this.program);

        renderInst.setGfxProgram(this.gfxProgram);
        renderInst.setMegaStateFlags(this.megaStateFlags);
        if (this.atlas !== undefined)
            renderInst.setSamplerBindingsFromTextureMappings([this.atlas]);
        renderInst.sortKey = makeSortKey(this.key.renderLayer);

        let offs = renderInst.allocateUniformBuffer(GTA3Program.ub_MeshFragParams, 12);
        const mapped = renderInst.mapUniformBufferF32(GTA3Program.ub_MeshFragParams);
        offs += fillMatrix4x3(mapped, offs, viewRenderer.camera.viewMatrix);
    }

    public destroy(device: GfxDevice): void {
        device.destroyBuffer(this.indexBuffer);
        device.destroyBuffer(this.vertexBuffer);
        device.destroyInputLayout(this.inputLayout);
        device.destroyInputState(this.inputState);
        if (this.atlas) this.atlas.destroy(device);
    }
}

export function layerKey(obj: ObjectDefinition, zone: string): MapLayerKey {
    let renderLayer = GfxRendererLayer.OPAQUE;
    if (obj.flags & ObjectFlags.NO_ZBUFFER_WRITE) {
        renderLayer = LAYER_SHADOWS;
    } else if (obj.flags & ObjectFlags.DRAW_LAST) {
        renderLayer = LAYER_TREES;
    }
    const key: MapLayerKey = { zone, renderLayer };
    if (obj.drawDistance < 99) {
        key.drawDistance = obj.drawDistance;
    }
    if (obj.tobj) {
        key.timeOn = obj.timeOn;
        key.timeOff = obj.timeOff;
    }
    return key;
}

function layerVisible(layer: MapLayer, viewerInput: Viewer.ViewerRenderInput) {
    const hour = Math.floor(viewerInput.time / TIME_FACTOR) % 24;
    const { timeOn, timeOff } = layer.key;
    if (timeOn !== undefined && timeOff !== undefined) {
        if (timeOn < timeOff && (hour < timeOn || timeOff < hour)) return false;
        if (timeOff < timeOn && (hour < timeOn && timeOff < hour)) return false;
    }

    if (!viewerInput.camera.frustum.contains(layer.bbox))
        return false;

    if (layer.key.drawDistance !== undefined) {
        const nearPlane = viewerInput.camera.frustum.planes[2];
        const c = vec3.create();
        layer.bbox.centerPoint(c);
        const dist = Math.abs(nearPlane.distance(c[0], c[1], c[2]));
        if (dist > layer.bbox.boundingSphereRadius() + 3 * layer.key.drawDistance)
            return false;
    }

    return true;
}

const bindingLayouts: GfxBindingLayoutDescriptor[] = [
    { numUniformBuffers: 2, numSamplers: 1 },
];

export class SceneRenderer {
    public modelCache = new ModelCache();
    public layers: MapLayer[] = [];

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, ambient: Color): void {
        const template = renderInstManager.pushTemplateRenderInst();
        template.setBindingLayouts(bindingLayouts);

        let offs = template.allocateUniformBuffer(GTA3Program.ub_SceneParams, 16 + 4);
        const sceneParamsMapped = template.mapUniformBufferF32(GTA3Program.ub_SceneParams);
        offs += fillMatrix4x4(sceneParamsMapped, offs, viewerInput.camera.projectionMatrix);
        offs += fillColor(sceneParamsMapped, offs, ambient);

        for (const layer of this.layers)
            if (layerVisible(layer, viewerInput))
                layer.prepareToRender(device, renderInstManager, viewerInput);

        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        for (const layer of this.layers.values())
            layer.destroy(device);
    }
}

export class GTA3Renderer implements Viewer.SceneGfx {
    public renderTarget = new BasicRenderTarget();
    public clearRenderPassDescriptor = makeClearRenderPassDescriptor(true, colorNew(0.1, 0.1, 0.1, 0.0));
    private ambient = colorNew(0.1, 0.1, 0.1);

    public sceneRenderers: SceneRenderer[] = [];

    private renderHelper: GfxRenderHelper;

    private weather = 0;
    private scenarioSelect: UI.SingleSelect;
    public onstatechanged!: () => void;

    constructor(device: GfxDevice, private colorSets: ColorSet[]) {
        this.renderHelper = new GfxRenderHelper(device);
    }

    public prepareToRender(device: GfxDevice, hostAccessPass: GfxHostAccessPass, viewerInput: Viewer.ViewerRenderInput): void {
        const t = viewerInput.time / TIME_FACTOR;
        const cs1 = this.colorSets[Math.floor(t)   % 24 + 24 * this.weather];
        const cs2 = this.colorSets[Math.floor(t+1) % 24 + 24 * this.weather];
        const skyTop = colorNewCopy(White);
        const skyBot = colorNewCopy(White);
        colorLerp(this.ambient, cs1.amb, cs2.amb, t % 1);
        colorLerp(skyTop, cs1.skyTop, cs2.skyTop, t % 1);
        colorLerp(skyBot, cs1.skyBot, cs2.skyBot, t % 1);
        colorLerp(this.clearRenderPassDescriptor.colorClearColor, skyTop, skyBot, 0.67); // fog

        viewerInput.camera.setClipPlanes(1);
        this.renderHelper.pushTemplateRenderInst();
        for (let i = 0; i < this.sceneRenderers.length; i++)
            this.sceneRenderers[i].prepareToRender(device, this.renderHelper.renderInstManager, viewerInput, this.ambient);
        this.renderHelper.renderInstManager.popTemplateRenderInst();
        this.renderHelper.prepareToRender(device, hostAccessPass);
    }

    public render(device: GfxDevice, viewerInput: Viewer.ViewerRenderInput): GfxRenderPass {
        const hostAccessPass = device.createHostAccessPass();
        this.prepareToRender(device, hostAccessPass, viewerInput);
        device.submitPass(hostAccessPass);

        this.renderTarget.setParameters(device, viewerInput.viewportWidth, viewerInput.viewportHeight);
        const finalPassRenderer = this.renderTarget.createRenderPass(device, this.clearRenderPassDescriptor);
        finalPassRenderer.setViewport(viewerInput.viewportWidth, viewerInput.viewportHeight);
        this.renderHelper.renderInstManager.drawOnPassRenderer(device, finalPassRenderer);

        this.renderHelper.renderInstManager.resetRenderInsts();

        return finalPassRenderer;
    }

    public createPanels(): UI.Panel[] {
        const scenarioPanel = new UI.Panel();
        scenarioPanel.customHeaderBackgroundColor = UI.COOL_BLUE_COLOR;
        scenarioPanel.setTitle(UI.TIME_OF_DAY_ICON, 'Weather');

        const scenarioNames = ['Sunny', 'Cloudy', 'Rainy', 'Foggy'];

        this.scenarioSelect = new UI.SingleSelect();
        this.scenarioSelect.setStrings(scenarioNames);
        this.scenarioSelect.onselectionchange = (index: number) => {
            if (this.weather === index) return;
            this.weather = index;
            this.onstatechanged();
            this.scenarioSelect.selectItem(index);
        };
        this.scenarioSelect.selectItem(0);
        scenarioPanel.contents.appendChild(this.scenarioSelect.elem);

        scenarioPanel.setVisible(scenarioNames.length > 0);

        return [scenarioPanel];
    }

    public destroy(device: GfxDevice): void {
        this.renderHelper.destroy(device);
        this.renderTarget.destroy(device);
        for (let i = 0; i < this.sceneRenderers.length; i++)
            this.sceneRenderers[i].destroy(device);
    }
}
