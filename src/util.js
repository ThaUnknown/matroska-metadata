import EventEmitter from 'events'

import { EbmlIteratorDecoder, Tools, EbmlTagId, EbmlElementType } from 'ebml-iterator'

function getChild (chunk, tag) {
  return chunk?._children.find(({ id }) => id === tag)
}

export default class Util extends EventEmitter {
  /** @type {Blob} */
  file

  destroyed = false
  implementsSlice = false
  /** @type {Promise<import('ebml-iterator').EbmlMasterTag>} */
  seekHead
  /** @type {Promise<import('ebml-iterator').EbmlMasterTag | undefined>} */
  segment
  /** @type {Promise<number | undefined>} */
  duration
  /** @type {Promise<{ number: string; language: string; type: string; _compressed?: boolean | undefined; }[]>} */
  tracks
  segmentStart = 0
  tagCache = {}

  processTags (tag) {
    if (tag.data && (tag.type === EbmlElementType.String || tag.type === EbmlElementType.UTF8 || tag.type == null)) {
      tag.data = tag.data.toString()
    }
    if (tag.Children) {
      for (const child of tag.Children) {
        this.processTags(child)
      }
    }
    return tag
  }

  /**
   * @param {AsyncIterable<any>} stream
   * @param {number} tagId
   */
  async readUntilTag (stream, tagId, bufferTag = true) {
    if (!tagId) throw new Error('tagId is required')

    const decoder = new EbmlIteratorDecoder({ stream, bufferTagIds: bufferTag ? [tagId] : [] })

    for await (const tag of decoder) {
      if (tag.id === tagId) return this.processTags(tag)
    }
    return null
  }

  /**
   * @param {AsyncIterable<any>} seekHeadStream
   * @param {number} segmentStart
   */
  async readSeekHead (seekHeadStream, segmentStart) {
    const seekHead = await this.readUntilTag(seekHeadStream, EbmlTagId.SeekHead)
    if (this.destroyed) return null
    if (!seekHead) throw new Error('Couldn\'t find seek head')

    const transformedHead = {}

    for (const child of seekHead.Children) {
      if (child.id !== EbmlTagId.Seek) continue // CRC32 elements will appear, currently we don't check them
      const tagName = EbmlTagId[Tools.readUnsigned(getChild(child, EbmlTagId.SeekID).data)]
      transformedHead[tagName] = getChild(child, EbmlTagId.SeekPosition)
    }

    // Determines if there is a second SeekHead referenced by the first SeekHead.
    // See: https://www.matroska.org/technical/ordering.html#seekhead
    // Note: If true, the first *must* contain a reference to the second, but other tags can be in the first.
    if (transformedHead.SeekHead) {
      const seekHeadStream = this.getFileStream(transformedHead.SeekHead + segmentStart)
      const secondSeekHead = await this.readSeekHead(seekHeadStream, segmentStart)
      return { ...secondSeekHead, ...transformedHead }
    } else {
      return transformedHead
    }
  }

  /**
   * @param {number | undefined} [start]
   */
  getFileStream (start) {
    // some file-likes might not implement slice: webtorrent
    // if they dont implement async iterator, error
    if (this.implementsSlice) {
      return this.file.slice(start).stream()[Symbol.asyncIterator]()
    } else {
      return this.file[Symbol.asyncIterator]({ start })
    }
  }

  /**
   * @returns {Promise<import('ebml-iterator').EbmlMasterTag| undefined>}
   */
  async getSegment () {
    if (this.segment) return await this.segment

    const segment = await this.readUntilTag(this.getFileStream(), EbmlTagId.Segment, false)
    if (!segment) return
    this.segmentStart = segment.absoluteStart + segment.tagHeaderLength
    return segment
  }

  async getSeekHead () {
    if (this.seekHead) return await this.seekHead

    await this.segment

    const seekHeadStream = this.getFileStream()
    return await this.readSeekHead(seekHeadStream, 0)
  }

  /**
   * @param {string} tag
   * @returns {Promise<null|import('ebml-iterator').EbmlMasterTag>}
   */
  async readSeekHeadTag (tag) {
    const seekHead = await this.seekHead

    const storedTag = tag.toLowerCase()
    if (!this.tagCache[storedTag] && seekHead[tag]) {
      const stream = this.getFileStream()
      const child = await this.readUntilTag(stream, EbmlTagId[tag])
      if (!child) return null
      child.absoluteStart = this.segmentStart + (seekHead[tag]?.data || 0)
      this.tagCache[storedTag] = child

      return this.tagCache[storedTag]
    }
    return this.tagCache[storedTag]
  }
}
