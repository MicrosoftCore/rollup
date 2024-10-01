import type { ModuleLoaderResolveId } from '../ModuleLoader';
import type { CustomPluginOptions, Plugin, ResolveIdResult } from '../rollup/types';
import type { PluginDriver } from './PluginDriver';
import { lstat, readdir, realpath } from './fs';
import { basename, dirname, isAbsolute, resolve } from './path';
import { resolveIdViaPlugins } from './resolveIdViaPlugins';

/**
 * @description @callee
 * first callee is the ModuleLoader.loadEntryModule
 * <PluginContext>this.load => ModuleLoader.resolveId => here
 * @author justinhone <justinhonejiang@gmail.com>
 * @date 2024-10-01 14:52
 */
export async function resolveId(
	source: string,
	importer: string | undefined,
	preserveSymlinks: boolean,
	pluginDriver: PluginDriver,
	moduleLoaderResolveId: ModuleLoaderResolveId,
	skip: readonly { importer: string | undefined; plugin: Plugin; source: string }[] | null, // null
	customOptions: CustomPluginOptions | undefined, // EMPTY_OBJECT
	isEntry: boolean, // true
	attributes: Record<string, string> // EMPTY_OBJECT
): Promise<ResolveIdResult> {
	/**
	 * @description node-resolve 每次返回绝对路径的 id 时，都会重新遍历所有插件的 resolveId
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-01 14:54
	 */
	const pluginResult = await resolveIdViaPlugins(
		source,
		importer,
		pluginDriver,
		moduleLoaderResolveId,
		skip,
		customOptions,
		isEntry,
		attributes
	);

	/**
	 * @description 如果解析结果不为空, 返回解析结果, 这个解析结果就是 this.resolveId 的结果
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-01 14:55
	 */
	if (pluginResult != null) {
		const [resolveIdResult, plugin] = pluginResult;
		if (typeof resolveIdResult === 'object' && !resolveIdResult.resolvedBy) {
			return {
				...resolveIdResult,
				resolvedBy: plugin.name
			};
		}
		if (typeof resolveIdResult === 'string') {
			return {
				id: resolveIdResult,
				resolvedBy: plugin.name
			};
		}
		return resolveIdResult;
	}

	// external modules (non-entry modules that start with neither '.' or '/')
	// are skipped at this stage.
	if (importer !== undefined && !isAbsolute(source) && source[0] !== '.') return null;

	// `resolve` processes paths from right to left, prepending them until an
	// absolute path is created. Absolute importees therefore shortcircuit the
	// resolve call and require no special handing on our part.
	// See https://nodejs.org/api/path.html#path_path_resolve_paths
	/**
	 * @description ⏯️看看人家是怎么处理 Extension 的
	 * @author justinhone <justinhonejiang@gmail.com>
	 * @date 2024-10-01 14:56
	 */
	return addJsExtensionIfNecessary(
		importer ? resolve(dirname(importer), source) : resolve(source),
		preserveSymlinks
	);
}

async function addJsExtensionIfNecessary(
	file: string,
	preserveSymlinks: boolean
): Promise<string | undefined> {
	return (
		(await findFile(file, preserveSymlinks)) ??
		(await findFile(file + '.mjs', preserveSymlinks)) ??
		(await findFile(file + '.js', preserveSymlinks))
	);
}

async function findFile(file: string, preserveSymlinks: boolean): Promise<string | undefined> {
	try {
		const stats = await lstat(file);
		if (!preserveSymlinks && stats.isSymbolicLink())
			return await findFile(await realpath(file), preserveSymlinks);
		if ((preserveSymlinks && stats.isSymbolicLink()) || stats.isFile()) {
			// check case
			const name = basename(file);
			const files = await readdir(dirname(file));

			if (files.includes(name)) return file;
		}
	} catch {
		// suppress
	}
}
