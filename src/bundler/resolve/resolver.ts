import * as async from "async";
import * as browserResolve from "browser-resolve";
import * as os from "os";
import * as path from "path";

import { Logger } from "log4js";

import { Configuration } from "../../shared/configuration";
import { SourceReader } from "./source-reader";
import PathTool = require("../../shared/path-tool");
import { DependencyWalker } from "../dependency-walker";
import { RequiredModule } from "../required-module";

export class Resolver {

    private shims: any;
    private filenameCache: string[] = [];
    private lookupNameCache: { [key: string]: string; } = {};

    constructor(private config: Configuration,
                private dependencyWalker: DependencyWalker,
                private log: Logger,
                private sourceReader: SourceReader) { }

    public initialize() {
        this.shims = this.config.bundlerOptions.addNodeGlobals ?
            require("./shims") : undefined;
        this.log.debug(this.shims);
    }

    public resolveModule(requiringModule: string,
                         requiredModule: RequiredModule,
                         buffer: RequiredModule[],
                         onRequiredModuleResolved: { (requiredModule: RequiredModule): void }) {

        requiredModule.lookupName = requiredModule.isNpmModule() ?
                requiredModule.moduleName :
                path.join(path.dirname(requiringModule), requiredModule.moduleName);

        if (this.lookupNameCache[requiredModule.lookupName]) {
            requiredModule.filename = this.lookupNameCache[requiredModule.lookupName];
            process.nextTick(() => {
                onRequiredModuleResolved(requiredModule);
            });
            return;
        }

        if (this.config.bundlerOptions.exclude.indexOf(requiredModule.moduleName) !== -1) {
            this.log.debug("Excluding module %s from %s", requiredModule.moduleName, requiringModule);
            process.nextTick(() => {
                onRequiredModuleResolved(requiredModule);
            });
            return;
        }

        let onFilenameResolved = () => {

            this.lookupNameCache[requiredModule.lookupName] = requiredModule.filename;

            if (this.isInFilenameCache(requiredModule) || requiredModule.isTypescriptFile()) {
                process.nextTick(() => {
                    onRequiredModuleResolved(requiredModule);
                });
            }
            else {
                this.filenameCache.push(requiredModule.filename);
                this.sourceReader.read(requiredModule, () => {
                    this.resolveDependencies(requiredModule, buffer, onDependenciesResolved);
                });
            }
        };

        let onDependenciesResolved = () => {
            buffer.push(requiredModule);
            return onRequiredModuleResolved(requiredModule);
        };

        this.resolveFilename(requiringModule, requiredModule, onFilenameResolved);
    }

    private isInFilenameCache(requiredModule: RequiredModule): boolean {
        return this.filenameCache.indexOf(requiredModule.filename) !== -1;
    }

    private resolveFilename(requiringModule: string, requiredModule: RequiredModule, onFilenameResolved: { (): void }) {

        let bopts = {
            extensions: this.config.bundlerOptions.resolve.extensions,
            filename: requiredModule.isNpmModule() ? undefined : requiringModule,
            moduleDirectory: this.config.bundlerOptions.resolve.directories,
            modules: this.shims,
            pathFilter: this.pathFilter.bind(this)
        };

        browserResolve(requiredModule.moduleName, bopts, (error, filename) => {
            if (error) {
                throw new Error("Unable to resolve module [" +
                    requiredModule.moduleName + "] from [" + requiringModule + "]" + os.EOL +
                    JSON.stringify(bopts, undefined, 2) + os.EOL +
                    error);
            }
            requiredModule.filename = filename;
            onFilenameResolved();
        });
    }

    private pathFilter(pkg: any, fullPath: string, relativePath: string): string {

        let filteredPath;
        let normalizedPath = PathTool.fixWindowsPath(fullPath);

        Object
            .keys(this.config.bundlerOptions.resolve.alias)
            .forEach((moduleName) => {
                let regex = new RegExp(moduleName);
                if (regex.test(normalizedPath) && pkg && relativePath) {
                    filteredPath = path.join(fullPath, this.config.bundlerOptions.resolve.alias[moduleName]);
                }
            });

        if (filteredPath) {
            return filteredPath;
        }
    }

    private resolveDependencies(requiredModule: RequiredModule,
                                buffer: RequiredModule[],
                                onDependenciesResolved: { (): void }) {

        if (requiredModule.isScript() && this.dependencyWalker.hasRequire(requiredModule.source)) {
            this.dependencyWalker.collectRequiredJsModules(requiredModule, (moduleNames) => {
                async.each(moduleNames, (moduleName, onModuleResolved) => {
                    let dependency = new RequiredModule(moduleName);
                    this.resolveModule(requiredModule.filename, dependency, buffer, (resolved) => {
                        if (resolved) {
                            requiredModule.requiredModules.push(resolved);
                        }
                        onModuleResolved();
                    });
                }, onDependenciesResolved);
            });
        }
        else {
            process.nextTick(() => {
                onDependenciesResolved();
            });
        }
    }
}