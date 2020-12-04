// @ts-ignore
;(global as any).WebSocket = require('ws')

import fs from 'fs'
import path from 'path'
import util from 'util'
import glob from 'glob'
import {
  bucketsList,
  bucketsLinks,
  bucketsRemove,
  bucketsCreate,
  bucketsPushPath,
  bucketsListPath,
  bucketsRemovePath,
  RootObject,
} from '@textile/buckets/dist/api'
import { Context } from '@textile/context'
import { GrpcConnection } from '@textile/grpc-connection'

const readFile = util.promisify(fs.readFile)
const globDir = util.promisify(glob)

function chunkBuffer(content: Buffer) {
  const size = 1024 * 1024
  const result = []
  const len = content.length
  let i = 0
  while (i < len) {
    result.push(content.slice(i, (i += size)))
  }
  return result
}

interface NextNode {
  files: Array<string>
  dirs: Array<string>
}
class BucketTree {
  constructor(public folders: Array<string> = [], public leafs: Array<string> = []) {}

  private removeFolder(folder: string) {
    const knownIndex = this.folders.indexOf(folder)
    if (knownIndex > -1) {
      this.folders.splice(knownIndex, 1)
    }
    return knownIndex
  }

  private removeLeaf(path: string) {
    const knownIndex = this.leafs.indexOf(path)
    if (knownIndex > -1) {
      this.leafs.splice(knownIndex, 1)
    }
    return knownIndex
  }

  remove(path: string) {
    if (path[0] !== '/') throw new Error('Unsupported path')
    const knownLeaf = this.removeLeaf(path)
    if (knownLeaf > -1) {
      let folder = `${path}`.replace(/\/[^\/]+$/, '')
      while (folder.length > 0) {
        // remove last folder
        this.removeFolder(folder)
        folder = folder.replace(/\/[^\/]+$/, '')
      }
    }
  }

  getDeletes() {
    let dirCount = this.folders.length
    let sorted = this.folders.sort((a, b) => a.length - b.length)
    for (let i = 0; i < dirCount; i++) {
      const folder = sorted[i]
      if (!folder) continue
      const reindex = false
      const folderDeletions = []
      for (const look of this.folders) {
        if (look.startsWith(`${folder}/`)) {
          folderDeletions.push(look)
        }
      }
      folderDeletions.forEach((drop) => this.removeFolder(drop))
      const fileDeleteions = []
      for (const look of this.leafs) {
        if (look.startsWith(`${folder}/`)) {
          fileDeleteions.push(look)
        }
      }
      fileDeleteions.forEach((drop) => this.removeLeaf(drop))
      if (reindex) {
        sorted = this.folders.sort((a, b) => a.length - b.length)
        dirCount = this.folders.length
      }
    }
    return [...this.leafs, ...this.folders]
  }
}

async function getNextNode(connection: GrpcConnection, bucketKey: string, path: string): Promise<NextNode> {
  const tree = await bucketsListPath(connection, bucketKey, path)
  const files: Array<string> = []
  const dirs: Array<string> = []
  if (tree.item) {
    for (const obj of tree.item.items) {
      if (obj.name === '.textileseed') continue
      if (obj.isDir) {
        dirs.push(`${path}/${obj.name}`)
      } else {
        files.push(`${path}/${obj.name}`)
      }
    }
  }
  return { files, dirs }
}

async function getTree(connection: GrpcConnection, bucketKey: string, path = '/'): Promise<BucketTree> {
  const leafs: Array<string> = []
  const folders: Array<string> = []
  const nodes: Array<string> = []
  const { files, dirs } = await getNextNode(connection, bucketKey, path)
  leafs.push(...files)
  folders.push(...dirs)
  nodes.push(...dirs)
  while (nodes.length > 0) {
    const dir = nodes.pop()
    if (!dir) continue
    const { files, dirs } = await getNextNode(connection, bucketKey, dir)
    leafs.push(...files)
    folders.push(...dirs)
    nodes.push(...dirs)
  }
  return new BucketTree(folders, leafs)
}

export type RunOutput = Map<string, string>

const makeid = (length: number) => {
  let result = ''
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const charactersLength = characters.length
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength))
  }
  return result
}

export async function execute(
  api: string,
  key: string,
  secret: string,
  session: string,
  thread: string,
  name: string,
  remove: string,
  pattern: string,
  dir: string,
  cleanOrphans: boolean,
  debug: boolean,
): Promise<RunOutput> {
  const target = api.trim() != '' ? api.trim() : undefined

  const response: RunOutput = new Map()

  if (!key || key === '' || !secret || secret === '') {
    throw Error('Invalid credentials')
  }

  const ctx = await new Context(target)
  if (session && session !== '') {
    ctx.withSession(session)
  } else {
    const keyInfo = {
      key,
      secret,
    }

    const expire: Date = new Date(Date.now() + 1000 * 1800) // 10min expiration
    await ctx.withKeyInfo(keyInfo, expire)
  }

  if (thread.trim() === '') {
    throw Error('Thread ID required')
  }

  ctx.withThread(thread)
  const connection = new GrpcConnection(ctx)

  if (name.trim() === '') {
    name = makeid(8)
  }

  const roots = await bucketsList(connection)
  const existing = roots.find((bucket: any) => bucket.name === name)
  if (remove === 'true') {
    if (existing) {
      await bucketsRemove(connection, existing.key)
      response.set('success', 'true')
      return response
    } else {
      throw Error('Bucket not found')
    }
  }

  let bucketKey = ''
  if (existing) {
    bucketKey = existing.key
  } else {
    const created = await bucketsCreate(connection, name)
    if (!created.root) {
      throw Error('Failed to create bucket')
    }
    bucketKey = created.root.key
  }

  let pathTree
  if (cleanOrphans) {
    pathTree = await getTree(connection, bucketKey, '')
  }

  const options = {
    cwd: dir,
    nodir: true,
  }
  const files = await globDir(pattern, options)
  if (files.length === 0) {
    throw Error(`No files found: ${dir}`)
  }
  // avoid requesting new head on every push path
  const head = await bucketsListPath(connection, bucketKey, `/`)
  let root: string | RootObject | undefined = head.root
  let raw
  for (const file of files) {
    if (pathTree) {
      pathTree.remove(`/${file}`)
    }
    const filePath = `${dir}/${file}`
    const buffer = await readFile(filePath)
    const content = chunkBuffer(buffer)
    const upload = {
      path: `/${file}`,
      content,
    }
    if (debug) {
      console.log('Uploading: ', file)
    }
    raw = await bucketsPushPath(connection, bucketKey, `/${file}`, upload, { root })
    root = raw.root
  }

  if (pathTree) {
    if (debug) {
      console.log('Cleaning orphaned nodes')
    }
    for (const orphan of pathTree.getDeletes()) {
      await bucketsRemovePath(connection, bucketKey, orphan)
    }
  }

  if (debug) {
    console.log('Upload complete')
  }
  return response
}

async function run(): Promise<void> {
  const path = process.env.BUCKET_PATH || ''
  const api = process.env.BUCKET_API || ''
  const key = process.env.BUCKET_KEY || ''
  const secret = process.env.BUCKET_SECRET || ''
  const thread = process.env.BUCKET_THREAD || ''
  const session = process.env.BUCKET_SESSION || ''
  const bucketName = process.env.BUCKET_NAME || ''
  const cleanOrphans = process.env.BUCKET_CLEAN == 'true'
  const debug = process.env.BUCKET_DEBUG == 'true'
  const remove = 'false'

  const pattern = '**/*'

  try {
    await execute(api, key, secret, session, thread, bucketName, remove, pattern, path, cleanOrphans, debug)
  } catch (error) {
    console.log(error.message)
  }
}

run()
