/* eslint-disable arrow-body-style */
import ExternalModule from './ExternalModule';
import type Graph from './Graph';
import Module, { type DynamicImport } from './Module';
import type {
	AstNode,
	CustomPluginOptions,
	EmittedChunk,
	HasModuleSideEffects,
	LoadResult,
	ModuleInfo,
	ModuleOptions,
	NormalizedInputOptions,
	PartialNull,
	Plugin,
	ResolvedId,
	ResolveIdResult
} from './rollup/types';
import type { PluginDriver } from './utils/PluginDriver';
import { EMPTY_OBJECT } from './utils/blank';
import { readFile } from './utils/fs';
import { LOGLEVEL_WARN } from './utils/logging';
import {
	error,
	logBadLoader,
	logEntryCannotBeExternal,
	logExternalModulesCannotBeIncludedInManualChunks,
	logExternalModulesCannotBeTransformedToModules,
	logExternalSyntheticExports,
	logImplicitDependantCannotBeExternal,
	logInconsistentImportAttributes,
	logInternalIdCannotBeExternal,
	logUnresolvedEntry,
	logUnresolvedImplicitDependant,
	logUnresolvedImport,
	logUnresolvedImportTreatedAsExternal
} from './utils/logs';
import {
	doAttributesDiffer,
	getAttributesFromImportExpression
} from './utils/parseImportAttributes';
import { isAbsolute, isRelative, resolve } from './utils/path';
import relativeId from './utils/relativeId';
import { resolveId } from './utils/resolveId';
import transform from './utils/transform';

export interface UnresolvedModule {
	fileName: string | null;
	id: string;
	importer: string | undefined;
	name: string | null;
}

export type ModuleLoaderResolveId = (
	source: string,
	importer: string | undefined,
	customOptions: CustomPluginOptions | undefined,
	isEntry: boolean | undefined,
	attributes: Record<string, string>,
	skip?: readonly { importer: string | undefined; plugin: Plugin; source: string }[] | null
) => Promise<ResolvedId | null>;

type NormalizedResolveIdWithoutDefaults = Partial<PartialNull<ModuleOptions>> & {
	external?: boolean | 'absolute';
	id: string;
	resolvedBy?: string;
};

type ResolveStaticDependencyPromise = Promise<readonly [source: string, resolvedId: ResolvedId]>;
type ResolveDynamicDependencyPromise = Promise<
	readonly [dynamicImport: DynamicImport, resolvedId: ResolvedId | string | null]
>;
type LoadModulePromise = Promise<
	[
		resolveStaticDependencies: ResolveStaticDependencyPromise[],
		resolveDynamicDependencies: ResolveDynamicDependencyPromise[],
		loadAndResolveDependencies: Promise<void>
	]
>;
type PreloadType = boolean | 'resolveDependencies';
const RESOLVE_DEPENDENCIES: PreloadType = 'resolveDependencies';

export class ModuleLoader {
	private readonly hasModuleSideEffects: HasModuleSideEffects;
	private readonly implicitEntryModules = new Set<Module>();
	private readonly indexedEntryModules: { index: number; module: Module }[] = [];
	private latestLoadModulesPromise: Promise<unknown> = Promise.resolve();
	private readonly moduleLoadPromises = new Map<Module, LoadModulePromise>();
	private readonly modulesWithLoadedDependencies = new Set<Module>();
	private nextChunkNamePriority = 0;
	private nextEntryModuleIndex = 0;

	constructor(
		private readonly graph: Graph,
		private readonly modulesById: Map<string, Module | ExternalModule>,
		private readonly options: NormalizedInputOptions,
		private readonly pluginDriver: PluginDriver
	) {
		/**
		 * @description 解析 treeshake options (merged by default)
		 * 如果没传则为空数组
		 * 📌 外部获取包含副作用的模块id传进来，看rollup如何分析
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-01 11:50
		 */
		this.hasModuleSideEffects = options.treeshake
			? options.treeshake.moduleSideEffects
			: () => true;
	}

	/**
	 * @description 此时入口文件还没解析，id 仍为用户设置的原始id
	 * @callee
	 * Graph.generateModuleGraph
	 * this.emitChunk
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-01 11:51
	 */
	async addEntryModules(
		unresolvedEntryModules: readonly UnresolvedModule[],
		isUserDefined: boolean
	): Promise<{
		entryModules: Module[];
		implicitEntryModules: Module[];
		newEntryModules: Module[];
	}> {
		const firstEntryModuleIndex = this.nextEntryModuleIndex;
		this.nextEntryModuleIndex += unresolvedEntryModules.length;
		const firstChunkNamePriority = this.nextChunkNamePriority;
		this.nextChunkNamePriority += unresolvedEntryModules.length;
		const newEntryModules = await this.extendLoadModulesPromise(
			Promise.all(
				unresolvedEntryModules.map(({ id, importer }) =>
					this.loadEntryModule(id, true, importer, null)
				)
			).then(entryModules => {
				for (const [index, entryModule] of entryModules.entries()) {
					entryModule.isUserDefinedEntryPoint =
						entryModule.isUserDefinedEntryPoint || isUserDefined;
					addChunkNamesToModule(
						entryModule,
						unresolvedEntryModules[index],
						isUserDefined,
						firstChunkNamePriority + index
					);
					const existingIndexedModule = this.indexedEntryModules.find(
						indexedModule => indexedModule.module === entryModule
					);
					if (existingIndexedModule) {
						existingIndexedModule.index = Math.min(
							existingIndexedModule.index,
							firstEntryModuleIndex + index
						);
					} else {
						this.indexedEntryModules.push({
							index: firstEntryModuleIndex + index,
							module: entryModule
						});
					}
				}
				this.indexedEntryModules.sort(({ index: indexA }, { index: indexB }) =>
					indexA > indexB ? 1 : -1
				);
				return entryModules;
			})
		);
		await this.awaitLoadModulesPromise();
		return {
			entryModules: this.indexedEntryModules.map(({ module }) => module),
			implicitEntryModules: [...this.implicitEntryModules],
			newEntryModules
		};
	}

	/**
	 * @description
	 * @method [resolveId] fire resolveId hooks
	 * @method [fetchModule]
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-04 13:01
	 */
	private async loadEntryModule(
		unresolvedId: string,
		isEntry: boolean,
		importer: string | undefined,
		implicitlyLoadedBefore: string | null,
		isLoadForManualChunks = false
	): Promise<Module> {
		const resolveIdResult = await resolveId(
			unresolvedId,
			importer,
			this.options.preserveSymlinks,
			this.pluginDriver,
			this.resolveId,
			null,
			EMPTY_OBJECT,
			true,
			EMPTY_OBJECT
		);
		if (resolveIdResult == null) {
			return error(
				implicitlyLoadedBefore === null
					? logUnresolvedEntry(unresolvedId)
					: logUnresolvedImplicitDependant(unresolvedId, implicitlyLoadedBefore)
			);
		}
		const isExternalModules = typeof resolveIdResult === 'object' && resolveIdResult.external;
		if (resolveIdResult === false || isExternalModules) {
			return error(
				implicitlyLoadedBefore === null
					? isExternalModules && isLoadForManualChunks
						? logExternalModulesCannotBeIncludedInManualChunks(unresolvedId)
						: logEntryCannotBeExternal(unresolvedId)
					: logImplicitDependantCannotBeExternal(unresolvedId, implicitlyLoadedBefore)
			);
		}
		/**
		 * @description 拿到入口文件的完整信息后开始解析入口文件
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-01 14:16
		 */
		return this.fetchModule(
			this.getResolvedIdWithDefaults(
				typeof resolveIdResult === 'object'
					? (resolveIdResult as NormalizedResolveIdWithoutDefaults)
					: { id: resolveIdResult },
				EMPTY_OBJECT
			)!,
			undefined,
			isEntry,
			false
		);
	}

	/**
	 * @description Module通过 addImport & ast parse 分析出当前模块的sourcesWithAttributes
	 * @type {sync function}
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-02 10:56
	 */
	private getResolveStaticDependencyPromises(module: Module): ResolveStaticDependencyPromise[] {
		// eslint-disable-next-line unicorn/prefer-spread
		return Array.from(
			module.sourcesWithAttributes,
			async ([source, attributes]) =>
				[
					source,
					(module.resolvedIds[source] =
						module.resolvedIds[source] ||
						this.handleInvalidResolvedId(
							await this.resolveId(source, module.id, EMPTY_OBJECT, false, attributes),
							source,
							module.id,
							attributes
						))
				] as const
		);
	}

	/**
	 * @description 解析动态引入
	 * @returns {Promise<readonly [dynamicImport: DynamicImport, resolvedId: ResolvedId | string | null]>}
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-02 11:27
	 */
	private getResolveDynamicImportPromises(module: Module): ResolveDynamicDependencyPromise[] {
		return module.dynamicImports.map(async dynamicImport => {
			const resolvedId = await this.resolveDynamicImport(
				module,
				dynamicImport.argument,
				module.id,
				getAttributesFromImportExpression(dynamicImport.node)
			);
			if (resolvedId && typeof resolvedId === 'object') {
				dynamicImport.id = resolvedId.id;
			}
			return [dynamicImport, resolvedId] as const;
		});
	}

	// If this is a preload, then this method always waits for the dependencies of
	// the module to be resolved.
	// Otherwise, if the module does not exist, it waits for the module and all
	// its dependencies to be loaded.
	// Otherwise, it returns immediately.
	/**
	 * @description @callee
	 * <PluginContext>.load => preloadModule isEntry: false, isPreload: resolveDependencies | true
	 * this.fetchResolvedDependency          isEntry: false, isPreload: false
	 * this.loadEntryModule                  isEntry: true | false, isPreload: false
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-04 02:26
	 */
	private async fetchModule(
		{ attributes, id, meta, moduleSideEffects, syntheticNamedExports }: ResolvedId,
		importer: string | undefined,
		isEntry: boolean,
		isPreload: PreloadType
	): Promise<Module> {
		const existingModule = this.modulesById.get(id);
		if (existingModule instanceof Module) {
			if (importer && doAttributesDiffer(attributes, existingModule.info.attributes)) {
				this.options.onLog(
					LOGLEVEL_WARN,
					logInconsistentImportAttributes(existingModule.info.attributes, attributes, id, importer)
				);
			}
			/**
			 * @description <PluginContext>.load 时 EntryModule ats 已经生成
			 * 等 dependencies 全部 load 完成
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-04 12:47
			 */
			await this.handleExistingModule(existingModule, isEntry, isPreload);
			return existingModule;
		}

		if (existingModule instanceof ExternalModule) {
			return error(logExternalModulesCannotBeTransformedToModules(existingModule.id));
		}

		/**
		 * @description 初始化 Module, 生成ModuleInfo, 但此时 moduleInfo 的各类信息都是空的,
		 * 比如 ast 还未初始化, 导入导出也未解析
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-01 14:14
		 */
		const module = new Module(
			this.graph,
			id,
			this.options,
			isEntry,
			moduleSideEffects,
			syntheticNamedExports,
			meta,
			attributes
		);
		this.modulesById.set(id, module);

		/**
		 * @description 主要做文件的读取, tranform 钩子的执行, ast语法树的解析,
		 * 和其他一些 ModuleInfo 信息的填充
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-02 11:23
		 */
		const loadPromise: LoadModulePromise = this.addModuleSource(id, importer, module).then(() => [
			/**
			 * @description sync get just an Array<Promise<[source, ResolvedId]>>
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-01 14:15
			 */
			this.getResolveStaticDependencyPromises(module),
			/**
			 * @description sync get just an Array<Promise<[dynamicImport, ResolvedId]>>
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-02 11:30
			 */
			this.getResolveDynamicImportPromises(module),
			/**
			 * @description await all static or dynamic dependencies resolved.
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-08 01:20
			 */
			loadAndResolveDependenciesPromise
		]);
		/**
		 * @description 等待当前模块的动态和静态模块加载完成,
		 * 通知钩子当前模块已经解析完成
		 *
		 * take two promise
		 * @fires 🧲[moduleParsed]
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-02 11:36
		 */
		const loadAndResolveDependenciesPromise = waitForDependencyResolution(loadPromise).then(() =>
			this.pluginDriver.hookParallel('moduleParsed', [module.info])
		);
		loadAndResolveDependenciesPromise.catch(() => {
			/* avoid unhandled promise rejections */
		});
		/**
		 * @description 记录下当前 Module 和它的 loadPromise
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-02 11:40
		 */
		this.moduleLoadPromises.set(module, loadPromise);
		/**
		 * @description waiting for all static and dynamic dependency loaded
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-04 02:10
		 */
		const resolveDependencyPromises = await loadPromise;

		/**
		 * @description @see {@link https://rollupjs.org/plugin-development/#this-load}
		 * this.load can only be called with true or resolveDependencies
		 *
		 * you can either implement a moduleParsed hook or pass the resolveDependencies flag,
		 * which will make the Promise returned by this.load wait until all dependency ids have been resolved.
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-02 11:48
		 */
		if (!isPreload) {
			/**
			 * @description [[],[],loadAndResolveDependenciesPromise],
			 * 目前发现 css 模块，但由于 ast 分析 module.sourcesWithAttributes为空，因此dependencePromise 都为空
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-04 12:38
			 */
			await this.fetchModuleDependencies(module, ...resolveDependencyPromises);
		} else if (isPreload === RESOLVE_DEPENDENCIES) {
			/**
			 * @description resolveDependencies
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-04 01:57
			 */
			await loadAndResolveDependenciesPromise;
		}
		return module;
	}

	/**
	 * @description called when !isPreload
	 * @callee
	 * this.handleExistingModule
	 * this.fetchModule
	 *
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-08 01:26
	 */
	private async fetchModuleDependencies(
		module: Module,
		resolveStaticDependencyPromises: readonly ResolveStaticDependencyPromise[],
		resolveDynamicDependencyPromises: readonly ResolveDynamicDependencyPromise[],
		loadAndResolveDependenciesPromise: Promise<void>
	): Promise<void> {
		if (this.modulesWithLoadedDependencies.has(module)) {
			return;
		}
		this.modulesWithLoadedDependencies.add(module);
		await Promise.all([
			this.fetchStaticDependencies(module, resolveStaticDependencyPromises),
			this.fetchDynamicDependencies(module, resolveDynamicDependencyPromises)
		]);
		module.linkImports();
		// To handle errors when resolving dependencies or in moduleParsed
		await loadAndResolveDependenciesPromise;
	}

	private async fetchStaticDependencies(
		module: Module,
		resolveStaticDependencyPromises: readonly ResolveStaticDependencyPromise[]
	): Promise<void> {
		for (const dependency of await Promise.all(
			resolveStaticDependencyPromises.map(resolveStaticDependencyPromise =>
				resolveStaticDependencyPromise.then(([source, resolvedId]) =>
					this.fetchResolvedDependency(source, module.id, resolvedId)
				)
			)
		)) {
			module.dependencies.add(dependency);
			dependency.importers.push(module.id);
		}
		if (!this.options.treeshake || module.info.moduleSideEffects === 'no-treeshake') {
			for (const dependency of module.dependencies) {
				if (dependency instanceof Module) {
					dependency.importedFromNotTreeshaken = true;
				}
			}
		}
	}

	private async fetchDynamicDependencies(
		module: Module,
		resolveDynamicImportPromises: readonly ResolveDynamicDependencyPromise[]
	): Promise<void> {
		const dependencies = await Promise.all(
			resolveDynamicImportPromises.map(resolveDynamicImportPromise =>
				resolveDynamicImportPromise.then(async ([dynamicImport, resolvedId]) => {
					if (resolvedId === null) return null;
					if (typeof resolvedId === 'string') {
						dynamicImport.resolution = resolvedId;
						return null;
					}
					return (dynamicImport.resolution = await this.fetchResolvedDependency(
						relativeId(resolvedId.id),
						module.id,
						resolvedId
					));
				})
			)
		);
		for (const dependency of dependencies) {
			if (dependency) {
				module.dynamicDependencies.add(dependency);
				dependency.dynamicImporters.push(module.id);
			}
		}
	}

	private fetchResolvedDependency(
		source: string,
		importer: string,
		resolvedId: ResolvedId
	): Promise<Module | ExternalModule> {
		if (resolvedId.external) {
			const { attributes, external, id, moduleSideEffects, meta } = resolvedId;
			let externalModule = this.modulesById.get(id);
			if (!externalModule) {
				externalModule = new ExternalModule(
					this.options,
					id,
					moduleSideEffects,
					meta,
					external !== 'absolute' && isAbsolute(id),
					attributes
				);
				this.modulesById.set(id, externalModule);
			} else if (!(externalModule instanceof ExternalModule)) {
				return error(logInternalIdCannotBeExternal(source, importer));
				/**
				 * @description ⏯️ 需要回看如何处理 external 模块
				 * @author justinhone <justinhonejiang@gmail.com>
				 * @date 2024-10-04 12:34
				 */
			} else if (doAttributesDiffer(externalModule.info.attributes, attributes)) {
				this.options.onLog(
					LOGLEVEL_WARN,
					logInconsistentImportAttributes(
						externalModule.info.attributes,
						attributes,
						source,
						importer
					)
				);
			}
			return Promise.resolve(externalModule);
		}
		return this.fetchModule(resolvedId, importer, false, false);
	}

	/**
	 * @description <PluginContext>.load 的调用时 preloadModule
	 * @callee <PluginContext>.load
	 *
	 * Add "resolveDependencies" option to "this.load"
	 * @see {@link https://github.com/rollup/rollup/pull/4358}
	 * This PR adds a flag resolveDependencies to this.load that will make this.load wait
	 * until importedIds and dynamicallyImportedIds for the module in question have been resolved.
	 * Thus it is no longer necessary to wait for moduleParsed to get this information.
	 *
	 * ☢️when waiting for this hook in resolveId,
	 * it is very easy to accidentally create a dead-lock where the hook waits for its own completion.
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-02 11:45
	 */
	public async preloadModule(
		resolvedId: { id: string; resolveDependencies?: boolean } & Partial<PartialNull<ModuleOptions>>
	): Promise<ModuleInfo> {
		const module = await this.fetchModule(
			this.getResolvedIdWithDefaults(resolvedId, EMPTY_OBJECT)!,
			undefined,
			false,
			resolvedId.resolveDependencies ? RESOLVE_DEPENDENCIES : true
		);
		return module.info;
	}

	/**
	 * @description @callee <PluginContext>.resolve
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-01 11:52
	 */
	resolveId: ModuleLoaderResolveId = async (
		source,
		importer,
		customOptions,
		isEntry,
		attributes,
		skip = null
	) => {
		return this.getResolvedIdWithDefaults(
			this.getNormalizedResolvedIdWithoutDefaults(
				/**
				 * @description @see {@link https://rollupjs.org/configuration-options/#external}
				 * 先排除掉已知的, 想要 external 化的模块
				 * @author justinhone <justinhonejiang@gmail.com>
				 * @date 2024-10-02 11:19
				 */
				this.options.external(source, importer, false)
					? false
					: await resolveId(
							source,
							importer,
							this.options.preserveSymlinks,
							this.pluginDriver,
							this.resolveId,
							skip,
							customOptions,
							typeof isEntry === 'boolean' ? isEntry : !importer,
							attributes
						),
				importer,
				source
			),
			attributes
		);
	};

	async addAdditionalModules(
		unresolvedModules: readonly string[],
		isAddForManualChunks: boolean
	): Promise<Module[]> {
		const result = this.extendLoadModulesPromise(
			Promise.all(
				unresolvedModules.map(id =>
					this.loadEntryModule(id, false, undefined, null, isAddForManualChunks)
				)
			)
		);
		await this.awaitLoadModulesPromise();
		return result;
	}

	private addEntryWithImplicitDependants(
		unresolvedModule: UnresolvedModule,
		implicitlyLoadedAfter: readonly string[]
	): Promise<Module> {
		const chunkNamePriority = this.nextChunkNamePriority++;
		return this.extendLoadModulesPromise(
			this.loadEntryModule(unresolvedModule.id, false, unresolvedModule.importer, null).then(
				async entryModule => {
					addChunkNamesToModule(entryModule, unresolvedModule, false, chunkNamePriority);
					if (!entryModule.info.isEntry) {
						const implicitlyLoadedAfterModules = await Promise.all(
							implicitlyLoadedAfter.map(id =>
								this.loadEntryModule(id, false, unresolvedModule.importer, entryModule.id)
							)
						);
						// We need to check again if this is still an entry module as these
						// changes need to be performed atomically to avoid race conditions
						// if the same module is re-emitted as an entry module.
						// The inverse changes happen in "handleExistingModule"
						if (!entryModule.info.isEntry) {
							this.implicitEntryModules.add(entryModule);
							for (const module of implicitlyLoadedAfterModules) {
								entryModule.implicitlyLoadedAfter.add(module);
							}
							for (const dependant of entryModule.implicitlyLoadedAfter) {
								dependant.implicitlyLoadedBefore.add(entryModule);
							}
						}
					}
					return entryModule;
				}
			)
		);
	}

	/**
	 * @description Get source from <PluginContext>.load or readFile
	 * then setSource
	 *
	 * @callhook
	 * load get source
	 * shouldTransformCachedModule ask if cacheModule
	 * transform for setSource
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-06 11:50
	 */
	private async addModuleSource(
		id: string,
		importer: string | undefined,
		module: Module
	): Promise<void> {
		let source: LoadResult;
		try {
			/**
			 * @description IO调用，耗时操作，加入队列中执行
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-01 11:53
			 */
			source = await this.graph.fileOperationQueue.run(async () => {
				const content = await this.pluginDriver.hookFirst('load', [id]);
				if (content !== null) return content;
				this.graph.watchFiles[id] = true;
				/**
				 * @description 如果没有 load 钩子处理此文件，则直接读文件内容
				 * @author justinhone <justinhonejiang@gmail.com>
				 * @date 2024-10-01 11:53
				 */
				return await readFile(id, 'utf8');
			});
		} catch (error_: any) {
			let message = `Could not load ${id}`;
			if (importer) message += ` (imported by ${relativeId(importer)})`;
			message += `: ${error_.message}`;
			error_.message = message;
			throw error_;
		}

		/**
		 * @description 这里可能是 load 钩子返回的结果
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-01 11:54
		 */
		const sourceDescription =
			typeof source === 'string'
				? { code: source }
				: source != null && typeof source === 'object' && typeof source.code === 'string'
					? source
					: error(logBadLoader(id));
		const code = sourceDescription.code;
		if (code.charCodeAt(0) === 0xfe_ff) {
			sourceDescription.code = code.slice(1);
		}

		/**
		 * @description Graph 初始化时设置的 cachedModules, 可以再回去看看初始化的逻辑
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-01 11:54
		 */
		const cachedModule = this.graph.cachedModules.get(id);
		if (
			cachedModule &&
			!cachedModule.customTransformCache &&
			cachedModule.originalCode === sourceDescription.code &&
			/**
			 * @fires 🧲[shouldTransformCachedModule]
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-01 11:55
			 */
			!(await this.pluginDriver.hookFirst('shouldTransformCachedModule', [
				{
					ast: cachedModule.ast,
					code: cachedModule.code,
					id: cachedModule.id,
					meta: cachedModule.meta,
					moduleSideEffects: cachedModule.moduleSideEffects,
					resolvedSources: cachedModule.resolvedIds,
					syntheticNamedExports: cachedModule.syntheticNamedExports
				}
			]))
		) {
			if (cachedModule.transformFiles) {
				for (const emittedFile of cachedModule.transformFiles)
					this.pluginDriver.emitFile(emittedFile);
			}
			await module.setSource(cachedModule);
		} else {
			/**
			 * @description 更新 moduleSideEffects, syntheticNamedExports, meta 三个信息
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-01 14:12
			 */
			module.updateOptions(sourceDescription);
			await module.setSource(
				await transform(sourceDescription, module, this.pluginDriver, this.options.onLog)
			);
		}
	}

	private async awaitLoadModulesPromise(): Promise<void> {
		let startingPromise;
		do {
			startingPromise = this.latestLoadModulesPromise;
			await startingPromise;
		} while (startingPromise !== this.latestLoadModulesPromise);
	}

	async emitChunk({
		fileName,
		id,
		importer,
		name,
		implicitlyLoadedAfterOneOf,
		preserveSignature
	}: EmittedChunk): Promise<Module> {
		const unresolvedModule: UnresolvedModule = {
			fileName: fileName || null,
			id,
			importer,
			name: name || null
		};
		const module = implicitlyLoadedAfterOneOf
			? await this.addEntryWithImplicitDependants(unresolvedModule, implicitlyLoadedAfterOneOf)
			: (await this.addEntryModules([unresolvedModule], false)).newEntryModules[0];
		if (preserveSignature != null) {
			module.preserveSignature = preserveSignature;
		}
		return module;
	}

	private extendLoadModulesPromise<T>(loadNewModulesPromise: Promise<T>): Promise<T> {
		this.latestLoadModulesPromise = Promise.all([
			loadNewModulesPromise,
			this.latestLoadModulesPromise
		]);
		this.latestLoadModulesPromise.catch(() => {
			/* Avoid unhandled Promise rejections */
		});
		return loadNewModulesPromise;
	}

	private getNormalizedResolvedIdWithoutDefaults(
		resolveIdResult: ResolveIdResult,
		importer: string | undefined,
		source: string
	): NormalizedResolveIdWithoutDefaults | null {
		const { makeAbsoluteExternalsRelative } = this.options;
		if (resolveIdResult) {
			if (typeof resolveIdResult === 'object') {
				const external =
					resolveIdResult.external || this.options.external(resolveIdResult.id, importer, true);
				return {
					...resolveIdResult,
					external:
						external &&
						(external === 'relative' ||
							!isAbsolute(resolveIdResult.id) ||
							(external === true &&
								isNotAbsoluteExternal(resolveIdResult.id, source, makeAbsoluteExternalsRelative)) ||
							'absolute')
				};
			}

			const external = this.options.external(resolveIdResult, importer, true);
			return {
				external:
					external &&
					(isNotAbsoluteExternal(resolveIdResult, source, makeAbsoluteExternalsRelative) ||
						'absolute'),
				id:
					external && makeAbsoluteExternalsRelative
						? normalizeRelativeExternalId(resolveIdResult, importer)
						: resolveIdResult
			};
		}

		const id = makeAbsoluteExternalsRelative
			? normalizeRelativeExternalId(source, importer)
			: source;
		if (resolveIdResult !== false && !this.options.external(id, importer, true)) {
			return null;
		}
		return {
			external: isNotAbsoluteExternal(id, source, makeAbsoluteExternalsRelative) || 'absolute',
			id
		};
	}

	private getResolvedIdWithDefaults(
		resolvedId: NormalizedResolveIdWithoutDefaults | null,
		attributes: Record<string, string>
	): ResolvedId | null {
		if (!resolvedId) {
			return null;
		}
		const external = resolvedId.external || false;
		return {
			attributes: resolvedId.attributes || attributes,
			external,
			id: resolvedId.id,
			meta: resolvedId.meta || {},
			moduleSideEffects:
				resolvedId.moduleSideEffects ?? this.hasModuleSideEffects(resolvedId.id, !!external),
			resolvedBy: resolvedId.resolvedBy ?? 'rollup',
			syntheticNamedExports: resolvedId.syntheticNamedExports ?? false
		};
	}

	/**
	 * @description
	 * <PluginContext>.resolveDependencies: true await static and dynamic dependencies,
	 * otherwise false await addModuleSource
	 *
	 * If isPreload is explicitly false, resolveId and fetchModule are called recursively.
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-09 23:17
	 */
	private async handleExistingModule(module: Module, isEntry: boolean, isPreload: PreloadType) {
		const loadPromise = this.moduleLoadPromises.get(module)!;
		if (isPreload) {
			/**
			 * @description @callee preloadModule
			 * pass the resolveDependencies flag,
			 * which will make the Promise returned by this.load wait until all dependency ids have been resolved.
			 *
			 * isPreload is RESOLVE_DEPENDENCIES when resolveDependencies options is true,
			 * or true when resolveDependencies options is false
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-07 01:22
			 */
			return isPreload === RESOLVE_DEPENDENCIES
				? /**
					 * @description await this.addModuleSource and the dpendencies module have
					 * <PluginContext>.load resolveDependencies: true
					 * @author justinhone <justinhonejiang@gmail.com>
					 * @date 2024-10-08 01:07
					 */
					waitForDependencyResolution(loadPromise)
				: /**
					 * @description await this.addModuleSource
					 * <PluginContext>.load resolveDependencies: false
					 * @author justinhone <justinhonejiang@gmail.com>
					 * @date 2024-10-08 01:06
					 */
					loadPromise;
		}
		if (isEntry) {
			// This reverts the changes in addEntryWithImplicitDependants and needs to
			// be performed atomically
			module.info.isEntry = true;
			this.implicitEntryModules.delete(module);
			for (const dependant of module.implicitlyLoadedAfter) {
				dependant.implicitlyLoadedBefore.delete(module);
			}
			module.implicitlyLoadedAfter.clear();
		}
		return this.fetchModuleDependencies(module, ...(await loadPromise));
	}

	private async resolveDynamicImport(
		module: Module,
		specifier: string | AstNode,
		importer: string,
		attributes: Record<string, string>
	): Promise<ResolvedId | string | null> {
		const resolution = await this.pluginDriver.hookFirst('resolveDynamicImport', [
			specifier,
			importer,
			{ attributes }
		]);
		if (typeof specifier !== 'string') {
			if (typeof resolution === 'string') {
				return resolution;
			}
			if (!resolution) {
				return null;
			}
			return this.getResolvedIdWithDefaults(
				resolution as NormalizedResolveIdWithoutDefaults,
				attributes
			);
		}
		if (resolution == null) {
			const existingResolution = module.resolvedIds[specifier];
			if (existingResolution) {
				if (doAttributesDiffer(existingResolution.attributes, attributes)) {
					this.options.onLog(
						LOGLEVEL_WARN,
						logInconsistentImportAttributes(
							existingResolution.attributes,
							attributes,
							specifier,
							importer
						)
					);
				}
				return existingResolution;
			}
			return (module.resolvedIds[specifier] = this.handleInvalidResolvedId(
				await this.resolveId(specifier, module.id, EMPTY_OBJECT, false, attributes),
				specifier,
				module.id,
				attributes
			));
		}
		return this.handleInvalidResolvedId(
			this.getResolvedIdWithDefaults(
				this.getNormalizedResolvedIdWithoutDefaults(resolution, importer, specifier),
				attributes
			),
			specifier,
			importer,
			attributes
		);
	}

	/**
	 * @description 📜可通过日志查询是否加载了不正确的模块
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-02 11:06
	 */
	private handleInvalidResolvedId(
		resolvedId: ResolvedId | null,
		source: string,
		importer: string,
		attributes: Record<string, string>
	): ResolvedId {
		if (resolvedId === null) {
			if (isRelative(source)) {
				return error(logUnresolvedImport(source, importer));
			}
			this.options.onLog(LOGLEVEL_WARN, logUnresolvedImportTreatedAsExternal(source, importer));
			return {
				attributes,
				external: true,
				id: source,
				meta: {},
				moduleSideEffects: this.hasModuleSideEffects(source, true),
				resolvedBy: 'rollup',
				syntheticNamedExports: false
			};
		} else if (resolvedId.external && resolvedId.syntheticNamedExports) {
			this.options.onLog(LOGLEVEL_WARN, logExternalSyntheticExports(source, importer));
		}
		return resolvedId;
	}
}

function normalizeRelativeExternalId(source: string, importer: string | undefined): string {
	return isRelative(source)
		? importer
			? resolve(importer, '..', source)
			: resolve(source)
		: source;
}

function addChunkNamesToModule(
	module: Module,
	{ fileName, name }: UnresolvedModule,
	isUserDefined: boolean,
	priority: number
): void {
	if (fileName !== null) {
		module.chunkFileNames.add(fileName);
	} else if (name !== null) {
		// Always keep chunkNames sorted by priority
		let namePosition = 0;
		while (module.chunkNames[namePosition]?.priority < priority) namePosition++;
		module.chunkNames.splice(namePosition, 0, { isUserDefined, name, priority });
	}
}

function isNotAbsoluteExternal(
	id: string,
	source: string,
	makeAbsoluteExternalsRelative: boolean | 'ifRelativeSource'
): boolean {
	return (
		makeAbsoluteExternalsRelative === true ||
		(makeAbsoluteExternalsRelative === 'ifRelativeSource' && isRelative(source)) ||
		!isAbsolute(id)
	);
}

async function waitForDependencyResolution(loadPromise: LoadModulePromise) {
	/**
	 * @description just await this.addModuleSource in the first step.
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-08 01:22
	 */
	const [resolveStaticDependencyPromises, resolveDynamicImportPromises] = await loadPromise;
	return Promise.all([...resolveStaticDependencyPromises, ...resolveDynamicImportPromises]);
}
