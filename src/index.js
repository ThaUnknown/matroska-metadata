import { inflateSync } from 'zlib'

import { arr2text } from 'uint8-util'
import { EbmlIteratorDecoder, EbmlTagId } from 'ebml-iterator'
import 'fast-readable-async-iterator'

import Util from './util.js'

const SSA_TYPES = new Set(['ssa', 'ass'])
const SSA_KEYS = ['readOrder', 'layer', 'style', 'name', 'marginL', 'marginR', 'marginV', 'effect', 'text']

/**
 * @param {import('ebml-iterator').EbmlMasterTag} chunk
 * @param {number} tag
 */
function getChild (chunk, tag) {
  return chunk?.Children.find(({ id }) => id === tag)
}
/**
 * @param {import('ebml-iterator').EbmlMasterTag} chunk
 * @param {number} tag
 */
function getData (chunk, tag) {
  return getChild(chunk, tag)?.data
}

export default class extends Util {
  implementsSlice = false
  timecodeScale = 1
  _currentClusterTimecode = null

  stable = false
  destroyed = false

  tagMap = {
    // Segment Information
    [EbmlTagId.TimecodeScale]: tag => {
      this.timecodeScale = tag.data / 1000000
    },
    // Assumption: This is a Cluster `Timecode`
    [EbmlTagId.Timecode]: tag => {
      this._currentClusterTimecode = tag.data
    },
    [EbmlTagId.BlockGroup]: data => this.handleBlockGroup(data)
  }

  /**
   * @type {Map<any, {number: string, language: string, type: string, _compressed?: boolean}>}
   */
  subtitleTracks = new Map()

  /**
   * @param {Blob} file
   */
  constructor (file) {
    super()
    this.file = file
    this.implementsSlice = !!file.slice

    this.segment = this.getSegment()
    this.seekHead = this.getSeekHead()
    this.duration = this.getDuration()
    this.tracks = this.getTracks()
  }

  /**
   * @returns {Promise<{filename: string, mimetype: string, data: Uint8Array}[]>}
   */
  async getAttachments () {
    return (await this.readSeekedTag('Attachments')).Children.map((/** @type {import("ebml-iterator").EbmlMasterTag} */ chunk) => ({
      filename: getData(chunk, EbmlTagId.FileName),
      mimetype: getData(chunk, EbmlTagId.FileMimeType),
      data: getData(chunk, EbmlTagId.FileData)
    }))
  }

  /**
   * @returns {Promise<{number: string, language: string, type: string, _compressed?: boolean}[]>}
   */
  async getTracks () {
    if (this.tracks) return await this.tracks
    const Tracks = await this.readSeekedTag('Tracks')

    for (const entry of Tracks.Children.filter(c => c.id === EbmlTagId.TrackEntry)) {
      // Skip non subtitle tracks
      if (getData(entry, EbmlTagId.TrackType) !== 0x11) continue

      const codecID = getData(entry, EbmlTagId.CodecID) || ''
      if (codecID.startsWith('S_TEXT')) {
        const track = {
          number: getData(entry, EbmlTagId.TrackNumber),
          language: getData(entry, EbmlTagId.Language),
          type: codecID.substring(7).toLowerCase()
        }

        const name = getData(entry, EbmlTagId.Name)
        if (name) track.name = name

        const header = getData(entry, EbmlTagId.CodecPrivate)
        if (header) track.header = arr2text(header)

        // TODO: Assume zlib deflate compression
        const compressed = entry.Children.find(c =>
          c.id === EbmlTagId.ContentEncodings &&
          c.Children.find(cc =>
            cc.id === EbmlTagId.ContentEncoding &&
            getChild(cc, EbmlTagId.ContentCompression)
          )
        )

        if (compressed) track._compressed = true

        this.subtitleTracks.set(track.number, track)
      }
    }

    const tracks = [...this.subtitleTracks.values()]

    return tracks
  }

  async getChapters () {
    const Chapters = await this.readSeekedTag('Chapters')

    const editions = Chapters.Children.filter(c => c.id === EbmlTagId.EditionEntry)

    // https://www.matroska.org/technical/chapters.html#default-edition
    // finds first default edition, or first entry
    const defaultEdition = editions.find(c => {
      return c.Children.some(cc => {
        return cc.id === EbmlTagId.EditionFlagDefault && Boolean(cc.data)
      })
    }) || editions[0]

    // exclude hidden atoms
    const atoms = defaultEdition.Children.filter(c => c.id === EbmlTagId.ChapterAtom && !getData(c, EbmlTagId.ChapterFlagHidden))

    const chapters = []
    for (let i = atoms.length - 1; i >= 0; --i) {
      const start = getData(atoms[i], EbmlTagId.ChapterTimeStart) / this.timecodeScale / 1000000
      const end = (getData(atoms[i], EbmlTagId.ChapterTimeEnd) / this.timecodeScale / 1000000) || chapters[i + 1]?.start || await this.duration
      const disp = getChild(atoms[i], EbmlTagId.ChapterDisplay)

      chapters[i] = {
        start,
        end,
        text: getData(disp, EbmlTagId.ChapString),
        language: getData(disp, EbmlTagId.ChapLanguage)
      }
    }

    return chapters
  }

  /**
   * @returns {Promise<number>}
   */
  async getDuration () {
    if (this.duration) return this.duration
    return (await this.readSeekedTag('Duration')).data
  }

  /**
   * @param {import("ebml-iterator").EbmlMasterTag} chunk
   */
  async handleBlockGroup (chunk) {
    await this.tracks

    const block = getChild(chunk, EbmlTagId.Block)

    if (block && this.subtitleTracks.has(block.track)) {
      const blockDuration = getData(chunk, EbmlTagId.BlockDuration)
      const track = this.subtitleTracks.get(block.track)

      if (!track) return

      const payload = track._compressed
        ? inflateSync(block.payload)
        : block.payload

      const subtitle = {
        text: arr2text(payload),
        time: (block.value + this._currentClusterTimecode) * this.timecodeScale,
        duration: blockDuration * this.timecodeScale
      }

      if (SSA_TYPES.has(track.type)) {
        // extract SSA/ASS keys
        const values = subtitle.text.split(',')

        // ignore read-order, and skip layer if ssa
        for (let i = track.type === 'ssa' ? 2 : 1; i < 8; i++) {
          subtitle[SSA_KEYS[i]] = values[i]
        }

        subtitle.text = values.slice(8).join(',')
      }

      this.emit('subtitle', subtitle, block.track)
    }
  }

  destroy () {
    this.destroyed = true
  }

  async * parseStream (stream) {
    let stable = this.stable
    this.stable = false
    const decoder = new EbmlIteratorDecoder({
      bufferTagIds: [
        EbmlTagId.TimecodeScale,
        EbmlTagId.BlockGroup,
        EbmlTagId.Duration
      ]
    })

    for await (const chunk of stream) {
      if (!stable) {
        for (let i = 0; i < chunk.length - 12; i++) {
          // EbmlTagId.Cluster: 524531317 aka 0x1F43B675
          // https://matroska.org/technical/elements.html#LevelCluster
          if (chunk[i] === 0x1f && chunk[i + 1] === 0x43 && chunk[i + 2] === 0xb6 && chunk[i + 3] === 0x75) {
            // length of cluster size tag
            const len = 8 - Math.floor(Math.log2(chunk[i + 4]))
            // first tag in cluster is a valid EbmlTag
            if (EbmlTagId[chunk[i + 4 + len]]) {
              // okay this is probably a cluster
              stable = true
              for (const tag of decoder.parseTags(chunk.slice(i))) {
                this.tagMap[tag.id]?.(tag)
              }
            }
          }
        }
      } else {
        for (const tag of decoder.parseTags(chunk)) {
          this.tagMap[tag.id]?.(tag)
        }
      }
      yield chunk
      if (this.destroyed) return null
    }
  }

  async parseFile () {
    this.stable = true
    // eslint-disable-next-line no-unused-vars
    for await (const _ of this.parseStream(this.getFileStream())) {
      if (this.destroyed) return null
    }
  }
}
