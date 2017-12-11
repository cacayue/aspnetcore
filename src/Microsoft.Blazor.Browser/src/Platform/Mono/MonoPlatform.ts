﻿import { MethodHandle, System_Object, System_String, Platform } from '../Platform';
import { getAssemblyNameFromUrl } from '../DotNet';

let assembly_load: (assemblyName: string) => number;
let find_class: (assemblyHandle: number, namespace: string, className: string) => number;
let find_method: (typeHandle: number, methodName: string, unknownArg: number) => MethodHandle;
let invoke_method: (method: MethodHandle, target: System_Object, argsArrayPtr: number, exceptionFlagIntPtr: number) => System_Object;
let mono_string_get_utf8: (managedString: System_String) => Mono.Utf8Ptr;
let mono_string: (jsString: string) => System_String;

export const monoPlatform: Platform = {
  start: function start(loadAssemblyUrls: string[]) {
    return new Promise<void>((resolve, reject) => {
      // mono.js assumes the existence of this
      window['Browser'] = {
        init: () => { },
        asyncLoad: asyncLoad
      };

      // Emscripten works by expecting the module config to be a global
      window['Module'] = createEmscriptenModuleInstance(loadAssemblyUrls, resolve, reject);

      addScriptTagsToDocument();
    });
  },

  findMethod: function findMethod(assemblyName: string, namespace: string, className: string, methodName: string): MethodHandle {
    // TODO: Cache the assembly_load outputs?
    const assemblyHandle = assembly_load(assemblyName);
    if (!assemblyHandle) {
      throw new Error(`Could not find assembly "${assemblyName}"`);
    }

    const typeHandle = find_class(assemblyHandle, namespace, className);
    if (!typeHandle) {
      throw new Error(`Could not find type "${className}'" in namespace "${namespace}" in assembly "${assemblyName}"`);
    }

    const methodHandle = find_method(typeHandle, methodName, -1);
    if (!methodHandle) {
      throw new Error(`Could not find method "${methodName}" on type "${namespace}.${className}"`);
    }

    return methodHandle;
  },

  callEntryPoint: function callEntryPoint(assemblyName: string, args: System_Object[]): void {
    // TODO: There should be a proper way of running whatever counts as the entrypoint without
    // having to specify what method it is, but I haven't found it. The code here assumes
    // that the entry point is "<assemblyname>.Program.Main" (i.e., namespace == assembly name).
    const entryPointMethod = monoPlatform.findMethod(assemblyName, assemblyName, 'Program', 'Main');
    monoPlatform.callMethod(entryPointMethod, null, args);
  },

  callMethod: function callMethod(method: MethodHandle, target: System_Object, args: System_Object[]): System_Object {
    const stack = Module.Runtime.stackSave();

    try {
      const argsBuffer = Module.Runtime.stackAlloc(args.length);
      const exceptionFlagManagedInt = Module.Runtime.stackAlloc(4);
      for (var i = 0; i < args.length; ++i) {
        Module.setValue(argsBuffer + i * 4, args[i], 'i32');
      }
      Module.setValue(exceptionFlagManagedInt, 0, 'i32');

      const res = invoke_method(method, target, argsBuffer, exceptionFlagManagedInt);

      if (Module.getValue(exceptionFlagManagedInt, 'i32') !== 0) {
        // If the exception flag is set, the returned value is exception.ToString()
        throw new Error(monoPlatform.toJavaScriptString(<System_String>res));
      }

      return res;
    } finally {
      Module.Runtime.stackRestore(stack);
    }
  },

  toJavaScriptString: function toJavaScriptString(managedString: System_String) {
    // Comments from original Mono sample:
    //FIXME this is wastefull, we could remove the temp malloc by going the UTF16 route
    //FIXME this is unsafe, cuz raw objects could be GC'd.

    if (!managedString) {
      return null;
    }

    const utf8 = mono_string_get_utf8(managedString);
    const res = Module.UTF8ToString(utf8);
    Module._free(utf8 as any);
    return res;
  },

  toDotNetString: function toDotNetString(jsString: string): System_String {
    return mono_string(jsString);
  }
};

function addScriptTagsToDocument() {
  // Load either the wasm or asm.js version of the Mono runtime
  const browserSupportsNativeWebAssembly = typeof WebAssembly !== 'undefined' && WebAssembly.validate;
  const monoRuntimeUrlBase = '/_framework/' + (browserSupportsNativeWebAssembly ? 'wasm' : 'asmjs');
  const monoRuntimeScriptUrl = `${monoRuntimeUrlBase}/mono.js`;

  if (!browserSupportsNativeWebAssembly) {
    // In the asmjs case, the initial memory structure is in a separate file we need to download
    const meminitXHR = Module['memoryInitializerRequest'] = new XMLHttpRequest();
    meminitXHR.open('GET', `${monoRuntimeUrlBase}/mono.js.mem`);
    meminitXHR.responseType = 'arraybuffer';
    meminitXHR.send(null);
  }

  document.write(`<script defer src="${monoRuntimeScriptUrl}"></script>`);
}

function createEmscriptenModuleInstance(loadAssemblyUrls: string[], onReady: () => void, onError: (reason: any) => void) {
  const module = {} as typeof Module;

  module.print = line => console.log(`WASM: ${line}`);
  module.printErr = line => console.error(`WASM: ${line}`);
  module.wasmBinaryFile = '/_framework/wasm/mono.wasm';
  module.asmjsCodeFile = '/_framework/asmjs/mono.asm.js';
  module.preRun = [];
  module.postRun = [];
  module.preloadPlugins = [];

  module.preRun.push(() => {
    // By now, emscripten should be initialised enough that we can capture these methods for later use
    assembly_load = Module.cwrap('mono_wasm_assembly_load', 'number', ['string']);
    find_class = Module.cwrap('mono_wasm_assembly_find_class', 'number', ['number', 'string', 'string']);
    find_method = Module.cwrap('mono_wasm_assembly_find_method', 'number', ['number', 'string', 'number']);
    invoke_method = Module.cwrap('mono_wasm_invoke_method', 'number', ['number', 'number', 'number']);
    mono_string_get_utf8 = Module.cwrap('mono_wasm_string_get_utf8', 'number', ['number']);
    mono_string = Module.cwrap('mono_wasm_string_from_js', 'number', ['string']);

    // TODO: Stop hard-coding this list, and instead automatically load whatever
    // dependencies were detected in ReferencedAssemblyFileProvider
    const loadBclAssemblies = [
      'mscorlib',
      'System',
      'System.Core',
      'System.Console',
      'System.Runtime',
    ];

    var allAssemblyUrls = loadAssemblyUrls
      .concat(loadBclAssemblies.map(name => `_framework/_bin/${name}.dll`));

    Module.FS_createPath('/', 'appBinDir', true, true);
    allAssemblyUrls.forEach(url =>
      FS.createPreloadedFile('appBinDir', `${getAssemblyNameFromUrl(url)}.dll`, url, true, false, null, <any>onError));
  });

  module.postRun.push(() => {
    const load_runtime = Module.cwrap('mono_wasm_load_runtime', null, ['string']);
    load_runtime('appBinDir');
    onReady();
  });

  return module;
}

function asyncLoad(url, onload, onerror) {
  var xhr = new XMLHttpRequest;
  xhr.open('GET', url, /* async: */ true);
  xhr.responseType = 'arraybuffer';
  xhr.onload = function xhr_onload() {
    if (xhr.status == 200 || xhr.status == 0 && xhr.response) {
      var asm = new Uint8Array(xhr.response);
      onload(asm);
    } else {
      onerror(xhr);
    }
  };
  xhr.onerror = onerror;
  xhr.send(null);
}
