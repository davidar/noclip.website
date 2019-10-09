
import * as Viewer from '../viewer';
import * as rw from 'librw';
import { GfxDevice } from '../gfx/platform/GfxPlatform';
import { DataFetcher } from '../DataFetcher';
import { GTA3Renderer, SceneRenderer, layerKey } from './render';
import { SceneContext } from '../SceneBase';
import { getTextDecoder, assert } from '../util';
import { parseItemPlacement, ItemPlacement, parseItemDefinition, ItemDefinition, ObjectDefinition, ItemInstance, parseZones } from './item';
import { parseTimeCycle, ColorSet } from './time';
import { quat, vec3 } from 'gl-matrix';
import { AABB } from '../Geometry';

const pathBase = `GrandTheftAuto3`;

class GTA3SceneDesc implements Viewer.SceneDesc {
    private static initialised = false;
    private ids: string[];

    constructor(public id: string, public name: string) {
        if (this.id === 'all') {
            this.ids = [
                "comntop/comNtop",
                "comnbtm/comNbtm",
                "comse/comSE",
                "comsw/comSW",
                "industne/industNE",
                "industnw/industNW",
                "industse/industSE",
                "industsw/industSW",
                "landne/landne",
                "landsw/landsw",
                "overview",
                "props"
            ];
        } else {
            this.ids = this.id.split(';');
        }
    }

    private static async initialise() {
        if (this.initialised)
            return;

        await rw.init({ gtaPlugins: true, platform: rw.Platform.PLATFORM_D3D8 });
        rw.Texture.setCreateDummies(true);
        rw.Texture.setLoadTextures(false);
        this.initialised = true;
    }

    private async fetchIDE(id: string, dataFetcher: DataFetcher): Promise<ItemDefinition> {
        const buffer = await dataFetcher.fetchData(`${pathBase}/data/maps/${id}.ide`);
        const text = getTextDecoder('utf8')!.decode(buffer.arrayBuffer);
        return parseItemDefinition(text);
    }

    private async fetchIPL(id: string, dataFetcher: DataFetcher): Promise<ItemPlacement> {
        if (id === 'test') return {
            instances: [{
                id: 0,
                modelName: 'billboard01',
                rotation: quat.fromValues(0,0,0,1),
                translation: vec3.fromValues(0,0,0),
                scale: vec3.fromValues(10,10,10),
            }]
        };
        const buffer = await dataFetcher.fetchData((id === 'props') ? `${pathBase}/data/maps/props.IPL` : `${pathBase}/data/maps/${id}.ipl`);
        const text = getTextDecoder('utf8')!.decode(buffer.arrayBuffer);
        return parseItemPlacement(text);
    }

    private async fetchTimeCycle(dataFetcher: DataFetcher): Promise<ColorSet[]> {
        const buffer = await dataFetcher.fetchData(`${pathBase}/data/timecyc.dat`);
        const text = getTextDecoder('utf8')!.decode(buffer.arrayBuffer);
        return parseTimeCycle(text);
    }

    private async fetchZones(dataFetcher: DataFetcher): Promise<Map<string, AABB>> {
        const buffer = await dataFetcher.fetchData(`${pathBase}/data/gta3.zon`);
        const text = getTextDecoder('utf8')!.decode(buffer.arrayBuffer);
        return parseZones(text);
    }

    public async createScene(device: GfxDevice, context: SceneContext): Promise<Viewer.SceneGfx> {
        await GTA3SceneDesc.initialise();
        const dataFetcher = context.dataFetcher;
        const objects = new Map<String, ObjectDefinition>();

        const ideids = ['generic', 'temppart/temppart', 'comroad/comroad', 'indroads/indroads', 'making/making', 'subroads/subroads'];
        for (const id of this.ids)
            if (id.match(/\//)) ideids.push(id.toLowerCase());
        const ides = await Promise.all(ideids.map(id => this.fetchIDE(id, dataFetcher)));
        for (const ide of ides) for (const obj of ide.objects) objects.set(obj.modelName, obj);

        const ipls = await Promise.all(this.ids.map(id => this.fetchIPL(id, dataFetcher)));
        const items = [] as [ItemInstance, ObjectDefinition][];
        for (const ipl of ipls) for (const item of ipl.instances) {
            const name = item.modelName;
            const obj = objects.get(name);
            if (!obj) {
                console.warn('No definition for object', name);
                continue;
            }
            if (name.startsWith('lod') || name.startsWith('islandlod')) continue; // ignore LOD objects
            items.push([item, obj]);
        }

        const [colorSets, zones] = await Promise.all([this.fetchTimeCycle(dataFetcher), this.fetchZones(dataFetcher)]);
        const renderer = new GTA3Renderer(device, colorSets);
        const sceneRenderer = new SceneRenderer();

        const loadedTXD = new Map<String, Promise<void>>();
        for (const [item, obj] of items) {
            if (!loadedTXD.has(obj.txdName)) {
                const txdPath = (obj.txdName === 'generic') ? `${pathBase}/models/generic.txd` : `${pathBase}/models/gta3/${obj.txdName}.txd`;
                loadedTXD.set(obj.txdName, dataFetcher.fetchData(txdPath).then(buffer => {
                    const stream = new rw.StreamMemory(buffer.arrayBuffer);
                    const header = new rw.ChunkHeaderInfo(stream);
                    assert(header.type === rw.PluginID.ID_TEXDICTIONARY);
                    const txd = new rw.TexDictionary(stream);
                    header.delete();
                    stream.delete();
                    renderer._textureHolder.addTXD(device, txd);
                    txd.delete();
                }));
            }
        }
        await Promise.all(loadedTXD.values());
        renderer._textureHolder.buildTextureAtlas(device);

        const loadedDFF = new Map<String, Promise<void>>();
        for (const [item, obj] of items) {
            if (!loadedDFF.has(obj.modelName)) {
                const dffPath = `${pathBase}/models/gta3/${obj.modelName}.dff`;
                loadedDFF.set(obj.modelName, dataFetcher.fetchData(dffPath).then(async buffer => {
                    const stream = new rw.StreamMemory(buffer.arrayBuffer);
                    const header = new rw.ChunkHeaderInfo(stream);
                    assert(header.type === rw.PluginID.ID_CLUMP);
                    const clump = rw.Clump.streamRead(stream);
                    header.delete();
                    stream.delete();
                    sceneRenderer.addModel(renderer._textureHolder, clump, obj);
                    clump.delete();
                }));
            }
        }

        for (const [item, obj] of items) {
            let zone = 'cityzon';
            for (const [name, bb] of zones) {
                if (bb.containsPoint(item.translation)) {
                    zone = name;
                    break;
                }
            }

            const layer = layerKey(obj, zone);
            const dffLoaded = loadedDFF.get(item.modelName);
            if (dffLoaded !== undefined)
                await dffLoaded.then(() => sceneRenderer.addItem(item, layer));
        }
        sceneRenderer.createLayers(device);
        renderer.sceneRenderers.push(sceneRenderer);
        return renderer;
    }
}

const id = `GrandTheftAuto3`;
const name = "Grand Theft Auto III";
const sceneDescs = [
    //new GTA3SceneDesc("test", "Test"),
    new GTA3SceneDesc("all", "Liberty City"),
    "Portland",
    new GTA3SceneDesc("industne/industNE", "North-east"),
    new GTA3SceneDesc("industnw/industNW", "North-west"),
    new GTA3SceneDesc("industse/industSE", "South-east"),
    new GTA3SceneDesc("industsw/industSW", "South-west"),
    "Staunton Island",
    new GTA3SceneDesc("comntop/comNtop", "North"),
    new GTA3SceneDesc("comnbtm/comNbtm", "Central"),
    new GTA3SceneDesc("comse/comSE", "South-east"),
    new GTA3SceneDesc("comsw/comSW", "South-west"),
    "Shoreside Vale",
    new GTA3SceneDesc("landne/landne", "North-east"),
    new GTA3SceneDesc("landsw/landsw", "South-west"),
];

export const sceneGroup: Viewer.SceneGroup = { id, name, sceneDescs };
