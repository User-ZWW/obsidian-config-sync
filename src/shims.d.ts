/**
 * 最小模块声明，避免依赖 DefinitelyTyped 上 yazl/yauzl 类型的可得性。
 * 只声明我们真正会用到的 API 面。
 */

declare module "yazl" {
	import type { Readable } from "node:stream";

	export interface AddFileOptions {
		mtime?: Date;
		mode?: number;
		compress?: boolean;
		size?: number;
	}

	export class ZipFile {
		constructor(options?: { forceZip64Format?: boolean });
		addFile(realPath: string, metadataPath: string, options?: AddFileOptions): void;
		addBuffer(buffer: Buffer, metadataPath: string, options?: AddFileOptions): void;
		addEmptyDirectory(metadataPath: string, options?: { mtime?: Date; mode?: number }): void;
		end(options?: { forceZip64Format?: boolean }, finalSizeCallback?: (finalSize: number) => void): void;
		readonly outputStream: Readable;
	}
}

declare module "yauzl" {
	import type { Readable } from "node:stream";

	export interface Entry {
		fileName: string;
		uncompressedSize: number;
		compressedSize: number;
		getLastModDate(): Date;
	}

	export class ZipFile {
		readEntry(): void;
		openReadStream(entry: Entry, callback: (err: Error | null, stream?: Readable) => void): void;
		on(event: "entry", listener: (entry: Entry) => void): this;
		on(event: "end", listener: () => void): this;
		on(event: "error", listener: (err: Error) => void): this;
		on(event: "close", listener: () => void): this;
		once(event: string, listener: (...args: unknown[]) => void): this;
		close(): void;
	}

	export interface OpenOptions {
		lazyEntries?: boolean;
		autoClose?: boolean;
		decodeStrings?: boolean;
		validateEntrySizes?: boolean;
	}

	export function open(
		path: string,
		options: OpenOptions,
		callback: (err: Error | null, zipfile?: ZipFile) => void,
	): void;
}
