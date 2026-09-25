import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";
import { TextDecoder as NodeTD, TextEncoder as NodeTE } from "node:util";

// jsdom's realm vs Node's WebCrypto: make sure both agree on typed arrays.
if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true });
Object.defineProperty(globalThis, "TextEncoder", { value: NodeTE, configurable: true });
Object.defineProperty(globalThis, "TextDecoder", { value: NodeTD, configurable: true });
