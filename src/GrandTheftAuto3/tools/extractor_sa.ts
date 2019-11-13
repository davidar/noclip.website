
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

const pathBase = '../../../data/GrandTheftAutoSanAndreas';

async function main() {
    const img = await fs.readFile(`${pathBase}/models/gta3.img`);
    const assets = loadDIR(img.buffer);
    await rw.init({ gtaPlugins: true, platform: rw.Platform.PLATFORM_D3D8 });
    rw.Texture.setCreateDummies(true);
    rw.Texture.setLoadTextures(false);

    const texturesOpaque: string[] = [];
    const texturesTransparent: string[] = [];
    const files = new Map<string, ArrayBuffer>();
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

                const list = transparent ? texturesTransparent : texturesOpaque;
                const index = list.length.toString(0x10).padStart(4, '0');
                const path = `${transparent ? 'transparent' : 'opaque'}/${index.substr(0, 2)}`;
                const fname = `${path}/${index.substr(2, 2)}.png`;
                list.push(`${txdName}/${texName}\n`);
                await fs.mkdir(`${pathBase}/textures/${path}`, { recursive: true });
                await finished(png.pack().pipe(createWriteStream(`${pathBase}/textures/${fname}`)));
                console.log(fname);

                image.delete();
            }
            txd.delete();
            header.delete();
            stream.delete();
        } else {
            files.set(name, buffer);
        }
    }
    await fs.writeFile(`${pathBase}/textures/opaque.txt`, texturesOpaque.join(''));
    await fs.writeFile(`${pathBase}/textures/transparent.txt`, texturesTransparent.join(''));

    let offset = Math.ceil((8 + 32 * files.size) / 2048);
    for (const [name, buffer] of files) {
        const size = buffer.byteLength / 2048;
        const asset: Asset = { name, size, offset };
        offset += size;
        console.log(asset);
    }
}

main();
