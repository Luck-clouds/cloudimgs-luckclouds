const path = require('path');
const config = require('../../config');
const { safeJoin } = require('../utils/fileUtils');

const SOURCE_TYPE_NATIVE = 'native';
const SOURCE_TYPE_EASYIMAGE = 'easyimage';

function isEasyImageSourceEnabled() {
    return !!(config.imageSource?.enabled && config.imageSource?.rootPath);
}

function getActiveSourceType() {
    return isEasyImageSourceEnabled() ? SOURCE_TYPE_EASYIMAGE : SOURCE_TYPE_NATIVE;
}

function getActiveMediaRoot() {
    if (isEasyImageSourceEnabled()) {
        return path.resolve(config.imageSource.rootPath);
    }
    return path.resolve(config.storage.path);
}

function isExternalRecord(record) {
    return !!record && record.source_type === SOURCE_TYPE_EASYIMAGE;
}

function resolveMediaPathFromRecord(record) {
    if (!record) return null;

    if (isExternalRecord(record)) {
        if (record.source_abs_path) {
            return path.resolve(record.source_abs_path);
        }
        const sourceRelPath = record.source_rel_path || record.rel_path;
        return safeJoin(getActiveMediaRoot(), sourceRelPath);
    }

    return safeJoin(path.resolve(config.storage.path), record.rel_path);
}

function resolveMediaPathFromRelPath(relPath) {
    return safeJoin(getActiveMediaRoot(), relPath);
}

module.exports = {
    SOURCE_TYPE_NATIVE,
    SOURCE_TYPE_EASYIMAGE,
    getActiveMediaRoot,
    getActiveSourceType,
    isEasyImageSourceEnabled,
    isExternalRecord,
    resolveMediaPathFromRecord,
    resolveMediaPathFromRelPath,
};
