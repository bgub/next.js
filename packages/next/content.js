const content = require('./dist/server/content')
exports.getCollection = content.getCollection
exports.getEntry = content.getEntry

const loaders = require('./dist/server/content/loaders')
exports.glob = loaders.glob
