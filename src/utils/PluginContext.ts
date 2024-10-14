import { version as rollupVersion } from 'package.json';
import type Graph from '../Graph';
import type {
	NormalizedInputOptions,
	Plugin,
	PluginCache,
	PluginContext,
	SerializablePluginCache
} from '../rollup/types';
import type { FileEmitter } from './FileEmitter';
import { createPluginCache, getCacheForUncacheablePlugin, NO_CACHE } from './PluginCache';
import { BLANK, EMPTY_OBJECT } from './blank';
import { getLogHandler } from './logHandler';
import { LOGLEVEL_DEBUG, LOGLEVEL_INFO, LOGLEVEL_WARN } from './logging';
import { error, logPluginError } from './logs';
import { normalizeLog } from './options/options';
import { parseAst } from './parseAst';
import { ANONYMOUS_OUTPUT_PLUGIN_PREFIX, ANONYMOUS_PLUGIN_PREFIX } from './pluginUtils';

export function getPluginContext(
	plugin: Plugin,
	pluginCache: Record<string, SerializablePluginCache> | void,
	graph: Graph,
	options: NormalizedInputOptions,
	fileEmitter: FileEmitter,
	existingPluginNames: Set<string>
): PluginContext {
	const { logLevel, onLog } = options;
	let cacheable = true;
	if (typeof plugin.cacheKey !== 'string') {
		if (
			plugin.name.startsWith(ANONYMOUS_PLUGIN_PREFIX) ||
			plugin.name.startsWith(ANONYMOUS_OUTPUT_PLUGIN_PREFIX) ||
			existingPluginNames.has(plugin.name)
		) {
			cacheable = false;
		} else {
			existingPluginNames.add(plugin.name);
		}
	}

	let cacheInstance: PluginCache;
	if (!pluginCache) {
		cacheInstance = NO_CACHE;
	} else if (cacheable) {
		const cacheKey = plugin.cacheKey || plugin.name;
		cacheInstance = createPluginCache(
			pluginCache[cacheKey] || (pluginCache[cacheKey] = Object.create(null))
		);
	} else {
		cacheInstance = getCacheForUncacheablePlugin(plugin.name);
	}

	return {
		addWatchFile(id) {
			graph.watchFiles[id] = true;
		},
		cache: cacheInstance,
		debug: getLogHandler(LOGLEVEL_DEBUG, 'PLUGIN_LOG', onLog, plugin.name, logLevel),
		emitFile: fileEmitter.emitFile.bind(fileEmitter),
		error(error_): never {
			return error(logPluginError(normalizeLog(error_), plugin.name));
		},
		getFileName: fileEmitter.getFileName,
		getModuleIds: () => graph.modulesById.keys(),
		getModuleInfo: graph.getModuleInfo,
		getWatchFiles: () => Object.keys(graph.watchFiles),
		info: getLogHandler(LOGLEVEL_INFO, 'PLUGIN_LOG', onLog, plugin.name, logLevel),
		load(resolvedId) {
			/**
			 * @description commonjs 在 resolveId 在 node-resolve resolveId 处理完成后调用 load
			 * @author justinhone <justinhonejiang@gmail.com>
			 * @date 2024-10-04 13:04
			 */
			return graph.moduleLoader.preloadModule(resolvedId);
		},
		meta: {
			rollupVersion,
			watchMode: graph.watchMode
		},
		parse: parseAst,
		/**
		 * @description BLANK 使用 Object.create(null) 创建的空对象, 不会继承Object的原型链
		 *
		 * @returns {Promise<ResolvedId | null>}
		 *
		 * @typedef {ResolvedId}
		 * @property {string} id @defaultvalue ResolvedId.id
		 * @property {boolean | 'absolute'} external @defaultvalue false
		 * @property {Record<string, string>} attributes @defaultvalue attributes
		 * @property {Record<string, any>} meta @defaultvalue {}
		 * @property {boolean | 'no-treeshake'} moduleSideEffects @defaultvalue 特殊处理
		 * @property {string} resolvedBy @defaultvalue 'rollup''
		 * @property {boolean | string} syntheticNamedExports @defaultvalue false
		 * @author justinhone <justinhonejiang@gmail.com>
		 * @date 2024-10-15 00:37
		 */
		resolve(source, importer, { attributes, custom, isEntry, skipSelf } = BLANK) {
			skipSelf ??= true;
			return graph.moduleLoader.resolveId(
				source,
				importer,
				custom,
				isEntry,
				attributes || EMPTY_OBJECT,
				skipSelf ? [{ importer, plugin, source }] : null
			);
		},
		setAssetSource: fileEmitter.setAssetSource,
		warn: getLogHandler(LOGLEVEL_WARN, 'PLUGIN_WARNING', onLog, plugin.name, logLevel)
	};
}
