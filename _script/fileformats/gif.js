import BinaryStream from "../util/binarystream.js";
import Palette from "../ui/palette.js";
import LZW from "../util/lzw.js";
import ImageFile from "../image.js";
import {buildColorLookup, duplicateCanvas} from "../util/canvasUtils.js";

const GIF = (()=>{
    const me = {};

    me.detect = function (file) {
        const id = file.readString(3, 0);
        if (id === "GIF") {
            let version = file.readString(3);
            return version === "87a" || version === "89a";
        }
        return false;
    };

    me.parse = function (file) {
        let img = {};
        file.goto(3);
        img.version = file.readString(3);

        //Logical Screen Descriptor
        img.width = file.readShort();
        img.height = file.readShort();
        let packed = file.readUbyte();
        img.gctFlag = (packed & 0b10000000) !== 0;
        img.colorResolution = (packed & 0b01110000) >> 4;
        img.sortFlag = (packed & 0b00001000) !== 0;
        img.gctSize = packed & 0b00000111;
        img.colorCount = 1 << (img.gctSize + 1);
        img.bgColorIndex = file.readUbyte();
        img.pixelAspectRatio = file.readUbyte();
        if (img.gctFlag) {
            img.palette = [];
            for (let i = 0; i < img.colorCount; i++) {
                let r = file.readUbyte();
                let g = file.readUbyte();
                let b = file.readUbyte();
                img.palette.push([r, g, b]);
            }
        }

        function parseBlock(){
            let block = {};
            block.id = file.readUbyte();
            switch (block.id) {
                case 0x21:
                    //Extension
                    block.label = file.readUbyte();
                    switch (block.label) {
                        case 0xF9:
                            //Graphics Control Extension
                            console.log("Graphics Control Extension Found");
                            block.size = file.readUbyte();
                            let packed = file.readUbyte();
                            img.disposalMethod = (packed & 0b00011100) >> 2;
                            //disposalMethod: 0: unspecified, 1: do not dispose, 2: restore to background, 3: restore to previous
                            img.userInputFlag = (packed & 0b00000010) !== 0;
                            img.transparentColorFlag = (packed & 0b00000001) !== 0;
                            img.delayTime = file.readShort();
                            img.transparentColorIndex = file.readUbyte();
                            file.readUbyte(); //block terminator
                            break;
                        case 0xFF:
                            //Application Extension
                            console.log("Application Extension Found");
                            block.size = file.readUbyte();
                            block.app = file.readString(11);
                            if (block.app === "NETSCAPE2.0") {
                                let subBlockSize = file.readUbyte();
                                if (subBlockSize >= 3) {
                                    file.jump(1);
                                    img.loopCount = file.readShort();
                                    file.jump(subBlockSize - 3);
                                } else {
                                    file.jump(subBlockSize);
                                }
                                skipSubBlocks();
                            } else {
                                skipSubBlocks();
                            }
                            break;
                        case 0xFE:
                            //Comment Extension
                            console.log("Comment Extension found, skipping");
                            skipSubBlocks();
                            break;
                        case 0x01:
                            //Plain Text Extension
                            console.log("Plain Text Extension found, skipping");
                            block.size = file.readUbyte();
                            file.jump(block.size);
                            skipSubBlocks();
                            break;
                        default:
                            console.error("Unknown GIF block label: " + block.label + ", skipping");
                            skipSubBlocks();
                    }
                    break;
                case 0x2C:
                    //Image Descriptor
                    console.log("Image Descriptor Found");
                    img.frames = img.frames || [];
                    let frame = {};
                    frame.left = file.readShort();
                    frame.top = file.readShort();
                    frame.width = file.readShort();
                    frame.height = file.readShort();
                    let packed = file.readUbyte();

                    block.lctFlag = (packed & 0b10000000) !== 0;
                    block.interlaceFlag = (packed & 0b01000000) !== 0;
                    block.sortFlag = (packed & 0b00100000) !== 0;
                    block.reserved = (packed & 0b00011000) >> 3;
                    block.lctSize = packed & 0b00000111;
                    block.colorCount = 1 << (block.lctSize + 1);

                    if (block.lctFlag) {
                        frame.palette = [];
                        for (let i = 0; i < block.colorCount; i++) {
                            let r = file.readUbyte();
                            let g = file.readUbyte();
                            let b = file.readUbyte();
                            frame.palette.push([r, g, b]);
                        }
                    }

                    block.lzwMinCodeSize = file.readUbyte();

                    let lzwData = [];
                    let size;
                    do {
                        size = file.readUbyte();
                        for (let i = 0; i < size; i++) lzwData.push(file.readUbyte());
                    } while (size > 0);

                    frame.pixels =  LZW.decode(lzwData, block.lzwMinCodeSize, frame.width*frame.height);
                    if (!frame.palette) frame.palette = img.palette;
                    if (img.transparentColorFlag){
                        frame.transparentColorIndex = img.transparentColorIndex;
                    }
                    // The Graphic Control Extension belongs to the image that follows it, so
                    // its disposal method is this frame's, not the file's. Keeping it here is
                    // what lets toFrames() treat frames with different disposals correctly.
                    frame.disposalMethod = img.disposalMethod || 0;
                    img.frames.push(frame);

                    break;
                case 0x3B:
                    //Trailer
                    console.log("EOF Found");
                    break;
                default:
                    console.error("Unknown GIF block: ", block);
            }
            return block;
        }

        function skipSubBlocks() {
            let size;
            do {
                size = file.readUbyte();
                file.jump(size);
            } while (size > 0 && !file.isEOF());
        }

        let block = parseBlock();
        while (block.id !== 0x3B) {
            block = parseBlock();
        }


        return img;
    }

    me.toCanvas = function (img) {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        let imageData =  new ImageData(img.width, img.height);

        img.pixels.forEach((pixel,index)=>{
            let color = img.palette[pixel] || [0,0,0];
            imageData.data[index*4] = color[0];
            imageData.data[index*4+1] = color[1];
            imageData.data[index*4+2] = color[2];
            imageData.data[index*4+3] = img.transparentColorIndex === pixel ? 0 : 255;
        });
        ctx.putImageData(imageData, 0, 0);
        return canvas;
    }

    me.toFrames = function (file) {
        let data = me.parse(file);
        let img;
        // gifs should have at least one frame
        if (data && data.frames && data.frames.length) {
            img = [];
            let restorePoint;
            data.frames.forEach((frame,index) => {
                let frameCanvas = GIF.toCanvas(frame);

                let canvas = document.createElement("canvas");
                canvas.width = data.width;
                canvas.height = data.height;
                let ctx = canvas.getContext("2d");

                // A frame's disposal method says what to do with ITS OWN AREA after it has
                // been shown, so what sits under frame N is decided by frame N-1's method:
                //
                //   0 / 1  leave it in place
                //   2      restore its area to the background. Only that frame's RECTANGLE is
                //          cleared — most animations are a full first frame followed by small
                //          sub-rectangles, and clearing the whole screen for each one wipes
                //          the animation down to a few stray patches. It is cleared to
                //          transparent rather than painted with the background colour, which
                //          is what browsers do for a GIF89a that declares a transparent index.
                //   3      restore what was on screen before that frame was drawn, which has
                //          to be remembered as we go (it is not frame 0).
                if (index > 0){
                    let previous = data.frames[index-1];
                    let disposal = previous.disposalMethod || 0;
                    if (disposal === 3){
                        if (restorePoint) ctx.drawImage(restorePoint, 0, 0);
                    }else{
                        ctx.drawImage(img[index-1], 0, 0);
                        if (disposal === 2){
                            ctx.clearRect(previous.left || 0, previous.top || 0,
                                previous.width || data.width, previous.height || data.height);
                        }
                    }
                }

                // "restore to previous" refers to the state before THIS frame is drawn, so
                // capture it here, while the canvas still holds only what came before.
                if ((frame.disposalMethod || 0) === 3) restorePoint = duplicateCanvas(canvas,true);

                ctx.drawImage(frameCanvas, frame.left || 0, frame.top || 0);
                img.push(canvas);
            });
        }
        if (img){
            return {
                image: img,
                type: "GIF",
                data: data,
            }
        }
    }


    me.write = function(canvas, options) {
        // write GIF file
        // https://www.w3.org/Graphics/GIF/spec-gif89a.txt

        // An array argument is the baked frame list from ImageFile.getBakedFrames():
        // already-resolved composites, so use them as they are.
        options = options || {};
        let frames = Array.isArray(canvas) ? canvas.slice() : [canvas];

        // Which timeline frame each entry came from. The indexed pixels are re-derived per
        // frame through ImageFile.generateIndexedPixels(frameIndex), so a caller writing a
        // single frame that is NOT frame 0 (Save as GIF -> "Frame") has to say which one it
        // is, or frame 0 would be encoded instead.
        let frameIndices = options.frameIndices || frames.map((frame,index)=>index);

        // TODO: set loop count in UI
        // TODO: set frame delay in UI

        // GIF delays are in 1/100 s; derive them from the timeline frame rate.
        let delayTime = 0;
        if (frames.length > 1) delayTime = Math.max(1, Math.round(100 / ImageFile.getFps()));

        let encodedFrames = [];
        // A copy: Palette.apply() below can rewrite the live palette mid-export, and the
        // colour table we write has to match the indices we encode.
        let palette = Palette.get().slice();

        // Anything the composite leaves fully transparent — the area a mask track conceals,
        // a layer that does not cover the whole document, a frame before a track's first key
        // — needs a palette slot of its own, declared as the transparent colour index in
        // every frame's Graphic Control Extension. Without it those pixels land on some
        // arbitrary index and come out as whatever colour sits there.
        let transparentIndex = frames.some(hasTransparentPixels)
            ? pickTransparentIndex(frames, palette)
            : -1;

        let colorDepth = 1;
        while (1 << colorDepth < palette.length) colorDepth++;
        let gctSize = colorDepth - 1;
        let colorCount = 1 << colorDepth;

        frames.forEach((frame,index)=>{
            let frameIndex = frameIndices[index];
            ImageFile.activateFrame(frameIndex);
            if (Palette.isLocked()){
                Palette.apply();
            }
            let pixels = ImageFile.generateIndexedPixels(frameIndex,true,transparentIndex);
            encodedFrames.push(LZW.encode(pixels,frame.width, frame.height, colorDepth));
        });


        let headerSize = 13 + colorCount*3;
        let gceSize = 8;
        let imageDescriptorSize = 10;
        let applicationExtensionSize = 19;


        let totalSize = headerSize + 1 + applicationExtensionSize;
        encodedFrames.forEach((frame)=>{
            totalSize += gceSize + imageDescriptorSize + frame.length;
        });
        console.log("Total GIF size: ", totalSize);
        let file = new BinaryStream(new ArrayBuffer(totalSize),false);

        //Header
        file.writeString("GIF89a");

        // Logical Screen Descriptor
        file.writeWord(frames[0].width);
        file.writeWord(frames[0].height);

        file.writeUbyte((0x80 | // 1 : global color table flag = 1 (gct used)
            0x70 | // 2-4 : color resolution = 7
            0x00 | // 5 : gct sort flag = 0
            gctSize)); // 6-8 : gct size

        file.writeUbyte(0); //background color index
        file.writeUbyte(0); //pixel aspect ratio

        //Global Color Table
        for (let i = 0; i < palette.length; i++) {
            file.writeUbyte(palette[i][0]);
            file.writeUbyte(palette[i][1]);
            file.writeUbyte(palette[i][2]);
        }
        let remaining = colorCount - palette.length;
        for (var i = 0; i < remaining*3; i++) file.writeUbyte(0);


        // write application extension to enable loop
        file.writeUbyte(0x21); //extension introducer
        file.writeUbyte(0xFF); //application extension label
        file.writeUbyte(0x0B); //block size
        file.writeString("NETSCAPE2.0");
        file.writeUbyte(0x03); //sub-block size
        file.writeUbyte(0x01); //sub-block id
        file.writeWord(0); //loop count
        file.writeUbyte(0x00); //block terminator


        frames.forEach((frame,index)=>{
            ////Graphics Control Extension
            file.writeUbyte(0x21); //extension introducer
            file.writeUbyte(0xF9); //graphic control label
            file.writeUbyte(0x04); //block size

            let transp = transparentIndex >= 0 ? 1 : 0;
            // Disposal 2 ("restore to background") is required once transparency is in play:
            // with disposal 0 the previous frame stays on screen under this frame's
            // transparent pixels, so a moving mask smears its old position across the
            // animation instead of revealing the background.
            let disp = transparentIndex >= 0 ? 2 : 0;
            disp <<= 2;

            // packed fields
            let packed = 0 | // 1:3 reserved
                disp | // 4:6 disposal
                0 | // 7 user input - 0 = none
                transp; // 8 transparency flag
            file.writeUbyte(packed);

            file.writeWord(delayTime); //delay time x 1/100 sec
            file.writeUbyte(transparentIndex >= 0 ? transparentIndex : 0); //transparent color index
            file.writeUbyte(0); //block terminator



            //Image Descriptor
            file.writeUbyte(0x2C); //image separator
            file.writeWord(0); //image left position
            file.writeWord(0); //image top position
            file.writeWord(frame.width); //image width
            file.writeWord(frame.height); //image height

            if (index === 0) {
                // no local color table
                file.writeUbyte(0);
            }else{
                // on second frame, if a local color table exists
                /*
                file.writeUbyte(0x80 | // 1 local color table 1=yes
                    0 | // 2 interlace - 0=no
                    0 | // 3 sorted - 0=no
                    0 | // 4-5 reserved
                    gctSize); // 6-8 size of color table

                // and write palette*/

                file.writeUbyte(0);
            }

            file.writeByteArray(encodedFrames[index]);
        })

        //Trailer
        file.writeUbyte(0x3B);

        return file.buffer;

    }

    // The palette slot to write fully transparent pixels as, in order of preference:
    //
    //   1. an index no OPAQUE pixel uses — costs nothing and keeps the colour table exactly
    //      the size the user's palette is, which matters when the palette is locked to a
    //      hardware set: a 32-colour document should still come back as 32 colours.
    //   2. a dedicated appended entry, when every palette colour is actually in use and there
    //      is room below 256. Nothing in the image is affected, the table just grows by one.
    //   3. the background colour index, as a last resort. With a full 256-colour palette where
    //      every colour is in use, transparency and that one colour cannot both be
    //      represented, so opaque pixels of that colour do go transparent.
    //
    // Appends to `palette` in place when it takes branch 2.
    function pickTransparentIndex(frames, palette){
        let usedByOpaque = new Uint8Array(palette.length);
        let lookup = buildColorLookup(palette);
        frames.forEach(frame=>{
            let data = frame.getContext("2d").getImageData(0,0,frame.width,frame.height).data;
            for (let i = 0; i < data.length; i += 4){
                if (data[i+3]) usedByOpaque[lookup(data[i],data[i+1],data[i+2])] = 1;
            }
        });
        for (let i = 0; i < usedByOpaque.length; i++){
            if (!usedByOpaque[i]) return i;
        }
        if (palette.length < 256){
            palette.push([0,0,0]);
            return palette.length - 1;
        }
        console.warn("GIF: palette is full and every colour is in use; transparent pixels will take the background colour");
        return typeof Palette.getBackColorIndex === "function" ? Palette.getBackColorIndex() : 0;
    }

    function hasTransparentPixels(canvas) {
        let imageData = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
        let pixels = imageData.data;

        for (let i = 3; i < pixels.length; i += 4) {
            if (pixels[i] === 0) { // fully transparent pixel found
                return true;
            }
        }
        return false;
    }

    return me;
})();

export default GIF;
