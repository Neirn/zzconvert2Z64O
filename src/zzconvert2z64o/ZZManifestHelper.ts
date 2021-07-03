import { basename } from 'path';
import { readFileSync } from 'fs';
import { SmartBuffer } from 'smart-buffer';
import { IModLoaderAPI } from 'modloader64_api/IModLoaderAPI';
import { guRTSF, guMtxF2L } from './MatrixHelper';

export class ZZManifestHelper {
    private dictionary!: Map<string, number>;
    private manifestOriginal!: Buffer;
    private manifestToDictionary!: Map<string, string>;
    private manifestToOffset!: Map<string, number>;
    private manifestFileName!: string;
    private zobj!: Buffer;
    private poolLocation!: number;
    private poolSize!: number;
    private aliasTable!: Buffer;
    private hierarchyHeader!: Buffer;
    private zobjName!: string;
    ModLoader!: IModLoaderAPI;

    constructor(manifest: string, zobj: Buffer, name: string, ModLoader: IModLoaderAPI) {
        this.manifestFileName = basename(manifest);
        this.manifestOriginal = readFileSync(manifest);
        this.ModLoader = ModLoader;
        this.zobj = zobj;
        this.zobjName = name;
        this.dictionary = new Map();

        this.parseManifest();
        this.findLinkHierarchyHeader();
        this.trimZobjManifest();
        this.parseDictionary();
        this.setDictionaryValues();
        this.generateAliasTable();
    }

    public getPoolOffset() {
        return this.poolLocation;
    }

    public getPoolSize() {
        return this.poolSize;
    }

    public getAliasTable() {
        return this.aliasTable;
    }

    public printDictionary() {
        console.log(this.dictionary);
    }

    public getZobj() {
        let buf = this.ModLoader.utils.cloneBuffer(this.zobj);

        this.aliasTable.copy(buf, this.poolLocation);

        return buf;
    }

    private findLinkHierarchyHeader() {

        // Link should always have 0x15 limbs where 0x12 have display lists
        // so, if a hierarchy exists, then this string must appear at least once
        let lowerHeaderBytes = Buffer.from("1500000012000000", 'hex');

        let possibleHeaderOffset = this.zobj.indexOf(lowerHeaderBytes);

        let headerOffset = -1;

        while (possibleHeaderOffset !== -1 && headerOffset === -1) {

            // this.ModLoader.logger.debug("Current header offset checked: 0x" + possibleHeaderOffset.toString(16));

            // start of the header needs 4 bytes of free space!
            if (possibleHeaderOffset >= 4) {
                let startOfIndeces = this.zobj.readInt32BE(possibleHeaderOffset - 4) & 0x00FFFFFF;

                //this.ModLoader.logger.debug("Current idx start checked: 0x" + startOfIndeces.toString(16));

                // if the offset is bigger than the zobj, we have problems
                // the offset must include space for all 20 limb indeces
                // also assume byte alignment
                if (startOfIndeces < (this.zobj.byteLength - 0x54) && (startOfIndeces % 8) === 0) {

                    // verify that there are indeed 20 limb indeces at this offset
                    let isLimbIndexList = true;
                    for (let i = 0; i < 0x15 && isLimbIndexList; i++) {
                        let currentIndexOffset = startOfIndeces + i * 0x04;

                        // check segment
                        if (this.zobj[currentIndexOffset] !== 0x06) {
                            isLimbIndexList = false;
                        } else {
                            let limbEntryOffset = this.zobj.readUInt32BE(currentIndexOffset) & 0x00FFFFFF;

                            // make sure offset is in zobj
                            // the offset should also leave enough space to fit a 0x10 byte limb entry
                            // also assume byte alignment
                            if (limbEntryOffset >= this.zobj.byteLength - 0x10 || limbEntryOffset % 8 !== 0) {
                                isLimbIndexList = false;
                            } else {
                                let highPolyOff = limbEntryOffset + 0x8;
                                let lowPolyOff = limbEntryOffset + 0xC;

                                let highPolyDLOffset = this.zobj.readUInt32BE(highPolyOff);
                                let lowPolyDLOffset = this.zobj.readUInt32BE(lowPolyOff);

                                // this.ModLoader.logger.debug("High Poly: 0x" + highPolyDLOffset.toString(16));
                                // this.ModLoader.logger.debug("Low Poly: 0x" + lowPolyDLOffset.toString(16));

                                isLimbIndexList = highPolyDLOffset === lowPolyDLOffset;
                            }
                        }
                    }

                    if (isLimbIndexList) {
                        headerOffset = possibleHeaderOffset - 4;
                    }
                }
            }

            possibleHeaderOffset = this.zobj.indexOf(lowerHeaderBytes, possibleHeaderOffset + 1);
        }

        if (headerOffset === -1) {
            throw new Error("Hierarchy could not be located in " + this.zobjName);
        }

        this.hierarchyHeader = this.ModLoader.utils.cloneBuffer(this.zobj.slice(headerOffset, headerOffset + 0xC));
    }

    private parseManifest() {

        let manifestOffset = this.zobj.indexOf("!PlayAsManifest");

        if (manifestOffset == -1) {
            throw new Error("Playas manifest not found in zobj!");
        }

        let numDisplayLists = this.zobj.readUInt16BE(manifestOffset + 0x10);

        let currentOffset = manifestOffset + 0x12;

        this.manifestToOffset = new Map();

        while (numDisplayLists > 0) {
            let start = currentOffset;
            while (this.zobj[currentOffset] !== 0 && currentOffset < this.zobj.length) {
                currentOffset++;
            }

            this.manifestToOffset.set(this.zobj.toString('utf8', start, currentOffset), this.zobj.readUInt32BE(currentOffset + 1))

            numDisplayLists--;
            currentOffset += 5;
        }
    }

    private trimZobjManifest() {

        let manifestOff = this.zobj.indexOf("!PlayAsManifest");

        if (manifestOff !== -1)
            this.zobj = this.zobj.slice(0, manifestOff);
    }

    private parseDictionary() {

        let dict = "DICTIONARY";

        let dictionaryOffset = this.manifestOriginal.indexOf(dict);

        if (dictionaryOffset === -1) {
            throw new Error("Could not find DICTIONARY in " + basename(this.manifestFileName))
        }

        let dictionary = this.manifestOriginal.slice(dictionaryOffset + dict.length, this.manifestOriginal.indexOf("END"));

        let lines = dictionary.toString().split(/\r?\n/);

        let m = new Map<string, string>();

        // TODO: Rewrite this
        lines.forEach((val, idx) => {
            val = val.trim();

            let commentIdx = val.indexOf('//');

            if (commentIdx !== -1) {
                val = val.slice(0, commentIdx).trim();
            }

            // this.ModLoader.logger.debug("Currrent dict parse: " + val)

            if (val !== "") {

                val = val.replace(/\s\s+/g, ' ');

                let components = val.split(' ');

                if (val.indexOf("DL_") === 0) {

                    // console.log(val);

                    // In case the manifest entry has a space in it, we concat
                    // everything after the entry name and bank offset
                    // TODO: Do this in a better way?
                    if (components.length > 3) {
                        let appnd = "";

                        for (let i = 2; i < components.length; i++) {
                            appnd += (' ' + components[i]);
                        }

                        components[2] = appnd;
                    }

                    let nameComponents = components[2].split('\"');

                    if (nameComponents.length !== 3) {
                        throw new Error("Malformed Dictionary entry in " + this.manifestFileName + " at line " + (idx + 1).toString() + '.\n Wrong number of \" symbols!');
                    }

                    m.set(nameComponents[1], components[0].trim());

                    /*
                    components.forEach((value, index) => {
                        console.log(index + ': ' + value);
                    });
                    */
                } else {
                    if (components.length !== 2) {
                        throw new Error("Malformed Dictionary entry in " + this.manifestFileName + " at line " + (idx + 1).toString());
                    }

                    try {
                        let entryOffset = parseInt(components[1], 16);

                        this.dictionary.set(components[0], entryOffset);
                    } catch (error) {
                        this.ModLoader.logger.error(error.message);
                        throw new Error("Unparsable Dictionary entry in " + this.manifestFileName + " at line " + (idx + 1).toString());
                    }
                }
            }
        });

        this.manifestToDictionary = m;
    }

    private setDictionaryValues() {

        /* Placeholder DF for objects that're pulled from the bank */
        this.dictionary.set("DL_DF_COMMAND", this.zobj.byteLength);
        this.zobj = Buffer.concat([this.zobj, Buffer.from("DF00000000000000", 'hex')]);

        // If this is a bank object, then we'll just set it to -1
        this.manifestToDictionary.forEach((val, key) => {
            this.dictionary.set(val, -1);
        });

        this.manifestToOffset.forEach((val, key) => {
            let translation = this.manifestToDictionary.get(key);

            if (translation !== undefined) {
                this.dictionary.set(translation, val);
            }
        });
    }

    // TODO: clean up this function
    private generateAliasTable() {
        let poolOffset = this.manifestOriginal.indexOf("OBJECT POOL");

        if (poolOffset === -1) {
            throw new Error("Could not find OBJECT POOL in manifest " + this.manifestFileName);
        }

        let pool = this.manifestOriginal.slice(poolOffset, this.manifestOriginal.indexOf("END", poolOffset));

        let firstLineEnd = pool.indexOf('\n');

        let malformedPoolErr = new Error("Malformed OBJECT POOL declaration in manifest " + this.manifestFileName);

        if (firstLineEnd === -1) {
            firstLineEnd = pool.indexOf('\r');

            if (firstLineEnd === -1) {
                throw malformedPoolErr;
            }
        }

        let firstLine = pool.toString('utf8', 0, firstLineEnd);
        firstLine = firstLine.replace(/\s+/g, '');

        let commaIdx = firstLine.indexOf(',');

        if (commaIdx === -1 || commaIdx === firstLine.length - 1) {
            throw malformedPoolErr;
        }

        try {
            this.poolSize = parseInt(firstLine.slice(commaIdx + 1), 16);
        } catch (error) {
            throw malformedPoolErr;
        }

        let eqIdx = firstLine.indexOf('=');

        if (eqIdx === -1) {
            throw malformedPoolErr;
        }

        try {
            this.poolLocation = parseInt(firstLine.slice(eqIdx + 1, commaIdx), 16);
        } catch (error) {
            throw malformedPoolErr;
        }

        let table = new SmartBuffer();

        let lines = pool.toString().split(/\r?\n/);

        function throwSyntaxError(manifestName: string, line: number) {
            throw new Error("Syntax error in OBJECT POOL in manifest " + manifestName + " at line " + line.toString());
        }

        // go through object pool line by line
        for (let i = 1; i < lines.length; i++) {

            // whitespace begone
            let line = lines[i].replace(/\s+/g, '');

            // remove comments
            let commentStart = line.indexOf('//');

            if (commentStart !== -1) {
                line = line.slice(0, commentStart).trim();
            }

            // skip empty line
            if (line === "") {
                continue;
            }

            // An alias table entry always has a colon after the name
            let colonIdx = line.indexOf(':');

            if (colonIdx !== -1) {

                let entryName = line.slice(0, colonIdx);

                if (this.dictionary.get(entryName) !== undefined) {
                    this.ModLoader.logger.error("Duplicate dictionary entry!");
                    throwSyntaxError(this.manifestFileName, i);
                }

                // add current entry to the dictionary
                this.dictionary.set(entryName, table.length + this.poolLocation);

                // in case we have multiple instructions on one line for some god-forsaken reason
                let manifestFuncs = line.slice(colonIdx + 1).split(';');

                let lastFunc = "";

                try {
                    manifestFuncs.forEach((funtionCall) => {
                        let call = funtionCall.trim();

                        if (call !== "") {
                            lastFunc = call;
                            table.writeBuffer(this.doPoolFunction(call));
                        }
                    });
                } catch (error) {
                    this.ModLoader.logger.error(error.message);
                    throwSyntaxError(this.manifestFileName, i);
                }

                // this next section could be cleaned up
                let j: number;

                // colon on next line indicates we are at the end of the current pool entry
                for (j = i + 1; j < lines.length && lines[j].indexOf(':') === -1; j++) {

                    // whitespace yeet
                    let nextLine = lines[j].replace(/\s+/g, '').trim();

                    // remove comment
                    commentStart = nextLine.indexOf('//');

                    if (commentStart !== -1) {
                        nextLine = nextLine.slice(0, commentStart).trim();
                    }

                    // skip empty line
                    if (nextLine === "") {
                        continue;
                    }

                    // just in case we have multiple calls on one line
                    manifestFuncs = nextLine.split(';');

                    // convert each function call to F3DZEX2 instructions
                    // also write matrices
                    try {
                        manifestFuncs.forEach((funtionCall) => {
                            let call = funtionCall.trim();

                            if (call !== "") {
                                lastFunc = call;
                                table.writeBuffer(this.doPoolFunction(call));
                            }
                        });
                    } catch (error) {
                        this.ModLoader.logger.error(error.message);
                        throwSyntaxError(this.manifestFileName, j);
                    }
                }

                // position i after most-recently processed line
                i = j - 1;

                // make the last command a DE01 if it was a DE command
                // TODO: check what zzplayas does if the last command isn't DE
                if (lastFunc.indexOf("CallList") !== -1) {
                    table.writeUInt8(0x01, table.length - 7);
                }
            }
        }

        table.writeBuffer(this.hierarchyHeader);

        let finalBuf = table.toBuffer();

        if (finalBuf.length > this.poolSize) {
            throw new Error("Alias table exceeds max OBJECT POOL size");
        }

        this.aliasTable = finalBuf;
    }

    private doPoolFunction(functionCall: string): Buffer {

        //this.ModLoader.logger.debug(functionCall);

        // verify that syntax is correct
        let argsStart = functionCall.indexOf('(');
        let argsEnd = functionCall.indexOf(')');

        if (argsStart === -1 || argsEnd === -1) {
            throw new Error("Error parsing arguments! (parentheses invalid)");
        }

        let funcName = functionCall.slice(0, argsStart);

        let args = functionCall.slice(argsStart + 1, argsEnd).split(',');

        let invalidArgNumErr = new Error("Invalid number of arguments!");
        let invalidArgsErr = new Error("Invalid argument!");

        let dictEntry;

        let buf: Buffer;

        switch (funcName) {
            case "CallList":

                if (args.length !== 1) {
                    throw invalidArgNumErr;
                }

                dictEntry = this.dictionary.get(args[0]);

                if (!dictEntry)
                    throw new Error("Dictionary entry not found: " + args[0]);

                // this was a bank object
                // just point it to a DF
                if (dictEntry === -1) {
                    dictEntry = this.dictionary.get("DL_DF_COMMAND");
                }

                dictEntry += 0x06000000;

                buf = Buffer.from("DE00000000000000", 'hex');

                buf.writeUInt32BE(dictEntry, 4);

                return buf;

                break;

            case "CallMatrix":

                if (args.length !== 1) {
                    throw invalidArgNumErr;
                }

                dictEntry = this.dictionary.get(args[0]);

                if (!dictEntry)
                    throw new Error("Dictionary entry not found: " + args[0]);

                dictEntry += 0x06000000;

                buf = Buffer.from("DA38000000000000", 'hex');

                buf.writeUInt32BE(dictEntry, 4);

                return buf;

                break;

            case "PopMatrix":

                if (args.length !== 1) {
                    throw invalidArgNumErr;
                }

                let popNum;

                try {
                    popNum = parseInt(args[0]);
                } catch (error) {
                    throw invalidArgsErr;
                }

                buf = Buffer.from("D838000200000000", 'hex');
                buf.writeUInt32BE(popNum * 0x40, 4);

                return buf;
                break;

            case "Matrix":

                if (args.length !== 9) {
                    throw invalidArgNumErr;
                }

                let matrixArgs: number[] = [];

                try {
                    args.forEach((arg) => {
                        matrixArgs.push(parseFloat(arg));
                    });
                } catch (error) {
                    this.ModLoader.logger.error(error.message);
                    throw invalidArgsErr;
                }

                return guMtxF2L(guRTSF(matrixArgs[0], matrixArgs[1], matrixArgs[2], matrixArgs[3], matrixArgs[4], matrixArgs[5], matrixArgs[6], matrixArgs[7], matrixArgs[8]));

                break;

            case "HexString":
                if (args.length !== 1) {
                    throw invalidArgNumErr;
                }

                try {
                    buf = Buffer.from(args[0], 'hex');
                } catch (error) {
                    throw new Error("Invalid hex string: " + args[0]);
                }

                return buf;

                break;

            default:
                throw new Error("Unknown function name " + "'" + funcName + "'");
        }

        throw new Error("HOW THE FUCK DID THE CODE GET HERE? THIS SHOULD BE UNREACHABLE.");

        return Buffer.alloc(0);
    }
}
