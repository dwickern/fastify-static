'use strict'

const path = require('path')
const url = require('url')
const statSync = require('fs').statSync
const { PassThrough } = require('readable-stream')
const glob = require('glob')
const send = require('send')
const contentDisposition = require('content-disposition')
const fp = require('fastify-plugin')
const util = require('util')
const globPromise = util.promisify(glob)
const encodingNegotiator = require('encoding-negotiator')

const dirList = require('./lib/dirList')

async function fastifyStatic (fastify, opts) {
  checkRootPathForErrors(fastify, opts.root)

  const setHeaders = opts.setHeaders

  if (setHeaders !== undefined && typeof setHeaders !== 'function') {
    throw new TypeError('The `setHeaders` option must be a function')
  }

  const invalidDirListOpts = dirList.validateOptions(opts.list)
  if (invalidDirListOpts) {
    throw invalidDirListOpts
  }

  const sendOptions = {
    root: opts.root,
    acceptRanges: opts.acceptRanges,
    cacheControl: opts.cacheControl,
    dotfiles: opts.dotfiles,
    etag: opts.etag,
    extensions: opts.extensions,
    immutable: opts.immutable,
    index: opts.index,
    lastModified: opts.lastModified,
    maxAge: opts.maxAge
  }

  const allowedPath = opts.allowedPath

  function pumpSendToReply (
    request,
    reply,
    pathname,
    rootPath,
    rootPathOffset = 0,
    pumpOptions = {},
    checkedExtensions
  ) {
    const options = Object.assign({}, sendOptions, pumpOptions)

    if (rootPath) {
      if (Array.isArray(rootPath)) {
        options.root = rootPath[rootPathOffset]
      } else {
        options.root = rootPath
      }
    }

    if (allowedPath && !allowedPath(pathname, options.root)) {
      return reply.callNotFound()
    }

    let encodingExt
    let pathnameForSend = pathname

    if (opts.preCompressed) {
      /**
       * We conditionally create this structure to track our attempts
       * at sending pre-compressed assets
       */
      if (!checkedExtensions) {
        checkedExtensions = new Set()
      }

      encodingExt = checkEncodingHeaders(request.headers, checkedExtensions)

      if (encodingExt) {
        pathnameForSend = pathname + '.' + encodingExt
      }
    }

    const stream = send(request.raw, pathnameForSend, options)
    let resolvedFilename
    stream.on('file', function (file) {
      resolvedFilename = file
    })

    const wrap = new PassThrough({
      flush (cb) {
        this.finished = true
        if (reply.raw.statusCode === 304) {
          reply.send('')
        }
        cb()
      }
    })

    wrap.getHeader = reply.getHeader.bind(reply)
    wrap.setHeader = reply.header.bind(reply)
    wrap.finished = false

    Object.defineProperty(wrap, 'filename', {
      get () {
        return resolvedFilename
      }
    })
    Object.defineProperty(wrap, 'statusCode', {
      get () {
        return reply.raw.statusCode
      },
      set (code) {
        reply.code(code)
      }
    })

    if (request.method === 'HEAD') {
      wrap.on('finish', reply.send.bind(reply))
    } else {
      wrap.on('pipe', function () {
        if (encodingExt) {
          reply.header('content-encoding', encodingExt)
        }
        reply.send(wrap)
      })
    }

    if (setHeaders !== undefined) {
      stream.on('headers', setHeaders)
    }

    stream.on('directory', function (_, path) {
      if (opts.list) {
        return dirList.send({
          reply,
          dir: path,
          options: opts.list,
          route: pathname
        })
      }

      if (opts.redirect === true) {
        /* eslint node/no-deprecated-api: "off" */
        const parsed = url.parse(request.raw.url)
        reply.redirect(301, parsed.pathname + '/' + (parsed.search || ''))
      } else {
        reply.callNotFound()
      }
    })

    stream.on('error', function (err) {
      if (err.code === 'ENOENT') {
        // if file exists, send real file, otherwise send dir list if name match
        if (opts.list && dirList.handle(pathname, opts.list)) {
          return dirList.send({ reply, dir: dirList.path(opts.root, pathname), options: opts.list, route: pathname })
        }

        // root paths left to try?
        if (Array.isArray(rootPath) && rootPathOffset < (rootPath.length - 1)) {
          return pumpSendToReply(request, reply, pathname, rootPath, rootPathOffset + 1)
        }

        if (opts.preCompressed && !checkedExtensions.has(encodingExt)) {
          checkedExtensions.add(encodingExt)
          return pumpSendToReply(
            request,
            reply,
            pathname,
            rootPath,
            undefined,
            undefined,
            checkedExtensions
          )
        }

        return reply.callNotFound()
      }
      reply.send(err)
    })

    // we cannot use pump, because send error
    // handling is not compatible
    stream.pipe(wrap)
  }

  if (opts.prefix === undefined) opts.prefix = '/'

  let prefix = opts.prefix

  if (!opts.prefixAvoidTrailingSlash) {
    prefix =
      opts.prefix[opts.prefix.length - 1] === '/'
        ? opts.prefix
        : opts.prefix + '/'
  }

  const errorHandler = (error, request, reply) => {
    if (error && error.code === 'ERR_STREAM_PREMATURE_CLOSE') {
      reply.request.raw.destroy()
      return
    }

    fastify.errorHandler(error, request, reply)
  }

  // Set the schema hide property if defined in opts or true by default
  const routeOpts = {
    schema: {
      hide: typeof opts.schemaHide !== 'undefined' ? opts.schemaHide : true
    },
    errorHandler: fastify.errorHandler ? errorHandler : undefined
  }

  if (opts.decorateReply !== false) {
    fastify.decorateReply('sendFile', function (filePath, rootPath) {
      pumpSendToReply(
        this.request,
        this,
        filePath,
        rootPath || sendOptions.root
      )
      return this
    })

    fastify.decorateReply(
      'download',
      function (filePath, fileName, options = {}) {
        const { root, ...opts } =
          typeof fileName === 'object' ? fileName : options
        fileName = typeof fileName === 'string' ? fileName : filePath

        // Set content disposition header
        this.header('content-disposition', contentDisposition(fileName))

        pumpSendToReply(this.request, this, filePath, root, 0, opts)

        return this
      }
    )
  }

  if (opts.serve !== false) {
    if (opts.wildcard && typeof opts.wildcard !== 'boolean') {
      throw new Error('"wildcard" option must be a boolean')
    }
    if (opts.wildcard === undefined || opts.wildcard === true) {
      fastify.head(prefix + '*', routeOpts, function (req, reply) {
        pumpSendToReply(req, reply, '/' + req.params['*'], sendOptions.root)
      })
      fastify.get(prefix + '*', routeOpts, function (req, reply) {
        pumpSendToReply(req, reply, '/' + req.params['*'], sendOptions.root)
      })
      if (opts.redirect === true && prefix !== opts.prefix) {
        fastify.get(opts.prefix, routeOpts, function (req, reply) {
          /* eslint node/no-deprecated-api: "off" */
          const parsed = url.parse(req.raw.url)
          reply.redirect(301, parsed.pathname + '/' + (parsed.search || ''))
        })
      }
    } else {
      const globPattern = '**/*'
      const indexDirs = new Map()
      const routes = new Set()

      for (const rootPath of Array.isArray(sendOptions.root) ? sendOptions.root : [sendOptions.root]) {
        const files = await globPromise(path.join(rootPath, globPattern), { nodir: true })
        const indexes = typeof opts.index === 'undefined' ? ['index.html'] : [].concat(opts.index)

        for (let file of files) {
          file = file
            .replace(rootPath.replace(/\\/g, '/'), '')
            .replace(/^\//, '')
          const route = encodeURI(prefix + file).replace(/\/\//g, '/')
          if (routes.has(route)) {
            continue
          }
          routes.add(route)
          fastify.head(route, routeOpts, function (req, reply) {
            pumpSendToReply(req, reply, '/' + file, rootPath)
          })

          fastify.get(route, routeOpts, function (req, reply) {
            pumpSendToReply(req, reply, '/' + file, rootPath)
          })

          const key = path.posix.basename(route)
          if (indexes.includes(key) && !indexDirs.has(key)) {
            indexDirs.set(path.posix.dirname(route), rootPath)
          }
        }
      }

      for (const [dirname, rootPath] of indexDirs.entries()) {
        const pathname = dirname + (dirname.endsWith('/') ? '' : '/')
        const file = '/' + pathname.replace(prefix, '')

        fastify.head(pathname, routeOpts, function (req, reply) {
          pumpSendToReply(req, reply, file, rootPath)
        })

        fastify.get(pathname, routeOpts, function (req, reply) {
          pumpSendToReply(req, reply, file, rootPath)
        })

        if (opts.redirect === true) {
          fastify.head(pathname.replace(/\/$/, ''), routeOpts, function (req, reply) {
            pumpSendToReply(req, reply, file.replace(/\/$/, ''), rootPath)
          })
          fastify.get(pathname.replace(/\/$/, ''), routeOpts, function (req, reply) {
            pumpSendToReply(req, reply, file.replace(/\/$/, ''), rootPath)
          })
        }
      }
    }
  }
}

function checkRootPathForErrors (fastify, rootPath) {
  if (rootPath === undefined) {
    throw new Error('"root" option is required')
  }

  if (Array.isArray(rootPath)) {
    if (!rootPath.length) {
      throw new Error('"root" option array requires one or more paths')
    }

    if ([...new Set(rootPath)].length !== rootPath.length) {
      throw new Error(
        '"root" option array contains one or more duplicate paths'
      )
    }

    // check each path and fail at first invalid
    rootPath.map((path) => checkPath(fastify, path))
    return
  }

  if (typeof rootPath === 'string') {
    return checkPath(fastify, rootPath)
  }

  throw new Error('"root" option must be a string or array of strings')
}

function checkPath (fastify, rootPath) {
  if (typeof rootPath !== 'string') {
    throw new Error('"root" option must be a string')
  }
  if (path.isAbsolute(rootPath) === false) {
    throw new Error('"root" option must be an absolute path')
  }

  let pathStat

  try {
    pathStat = statSync(rootPath)
  } catch (e) {
    if (e.code === 'ENOENT') {
      fastify.log.warn(`"root" path "${rootPath}" must exist`)
      return
    }

    throw e
  }

  if (pathStat.isDirectory() === false) {
    throw new Error('"root" option must point to a directory')
  }
}

const supportedEncodings = ['br', 'gzip', 'deflate']

// Adapted from https://github.com/fastify/fastify-compress/blob/fa5c12a5394285c86d9f438cb39ff44f3d5cde79/index.js#L442
function checkEncodingHeaders (headers, checked) {
  if (!('accept-encoding' in headers)) return

  let ext
  const header = headers['accept-encoding'].toLowerCase().replace('*', 'gzip')
  const accepted = encodingNegotiator.negotiate(
    header,
    supportedEncodings.filter((enc) => !checked.has(enc))
  )

  switch (accepted) {
    case 'br':
      ext = 'br'
      break

    case 'gzip':
      if (!checked.has('gz')) {
        ext = 'gz'
        break
      }
  }

  return ext
}

module.exports = fp(fastifyStatic, {
  fastify: '3.x',
  name: 'fastify-static'
})
