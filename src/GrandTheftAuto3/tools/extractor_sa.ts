
import { createWriteStream, promises as fs } from 'fs';
import * as stream from 'stream';
import { TextDecoder, promisify } from 'util';
import { PNG } from 'pngjs';
import * as rw from 'librw';

const finished = promisify(stream.finished);

function UTF8ToString(array: Uint8Array) {
    let length = 0; while (length < array.length && array[length]) length++;
    return new TextDecoder().decode(array.subarray(0, length));
}

interface Asset {
    offset: number;
    size: number;
    name: string;
}

function loadDIR(buf: ArrayBuffer) {
    let assets = [] as Asset[];
    let view = new DataView(buf);
    const start = 8;
    const dirLength = 32 * view.getUint32(4, true);
    for (let i = start; i < start + dirLength; i += 32) {
        let offset = view.getUint32(i + 0, true);
        let size = view.getUint16(i + 4, true);
        let name = UTF8ToString(new Uint8Array(buf, i + 8, 24));
        assets.push({ offset, size, name });
    }
    return assets;
}

function loadAsset(img: ArrayBuffer, asset: Asset) {
    return img.slice(2048 * asset.offset, 2048 * (asset.offset + asset.size));
}

interface Metadata {
    txd: string;
    name: string;
    index: string;
}

const pathBase = '../../../data/GrandTheftAutoSanAndreas/models/gta3';

async function main() {
    const img = await fs.readFile(pathBase + '.img');
    const assets = loadDIR(img.buffer);
    await rw.init({ gtaPlugins: true, platform: rw.Platform.PLATFORM_D3D8 });
    rw.Texture.setCreateDummies(true);
    rw.Texture.setLoadTextures(false);
    await fs.mkdir(pathBase, { recursive: true });

    const textures = { opaque: [] as Metadata[], transparent: [] as Metadata[] };
    for (const asset of assets) {
        const name = asset.name.toLowerCase();
        const buffer = loadAsset(img.buffer, asset);
        if (name.endsWith('.txd')) {
            const txdName = name.substr(0, name.length - 4);
            const stream = new rw.StreamMemory(new Uint8Array(buffer));
            const header = new rw.ChunkHeaderInfo(stream);
            if (header.type !== rw.PluginID.ID_TEXDICTIONARY) throw new Error('invalid TXD');

            const txd = new rw.TexDictionary(stream);
            for (let lnk = txd.textures.begin; !lnk.is(txd.textures.end); lnk = lnk.next) {
                const texture = rw.Texture.fromDict(lnk);
                const texName = texture.name.toLowerCase();
                const image = texture.raster.toImage();
                image.unindex();

                const { width, height, bpp } = image;
                const transparent = image.hasAlpha();
                const pixels = image.pixels!;

                const png = new PNG({ width, height, colorType: transparent ? 6 : 2 });
                for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
                    const i = x + y * width;
                    png.data[4*i+0] = pixels[bpp*i+0];
                    png.data[4*i+1] = pixels[bpp*i+1];
                    png.data[4*i+2] = pixels[bpp*i+2];
                    if (bpp === 4) png.data[4*i+3] = pixels[bpp*i+3];
                }

                const list = transparent ? textures.transparent : textures.opaque;
                const index = list.length.toString(0x10).padStart(4, '0');
                const path = `${transparent ? 'transparent' : 'opaque'}/${index.substr(0, 2)}`;
                const fname = `${path}/${index.substr(2, 2)}.png`;
                list.push({ txd: txdName, name: texName, index })
                await fs.mkdir(`${pathBase}/../../textures/${path}`, { recursive: true });
                await finished(png.pack().pipe(createWriteStream(`${pathBase}/../../textures/${fname}`)));
                console.log(fname);

                image.delete();
            }
            txd.delete();
            header.delete();
            stream.delete();
        } else {
            await fs.writeFile(`${pathBase}/${name}`, Buffer.from(buffer));
            console.log(name);
        }
    }
    await fs.writeFile(`${pathBase}/../../textures/index.json`, JSON.stringify(textures, null, 2));
}

main();
