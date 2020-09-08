import stream from 'readable-stream'
import internal, { Readable } from 'stream'

interface FactoryStreamCallback {
  (err: Error | null, stream: null): any
  (err: null, stream: Readable): any
}
type LazyStream = () => Readable
type FactoryStream = (cb: FactoryStreamCallback) => void
type Streams = Array<LazyStream | Readable> | FactoryStream

function toStreams2Obj (s: LazyStream | Readable):Readable {
  return toStreams2(s, { objectMode: true, highWaterMark: 16 })
}

function toStreams2Buf (s:  LazyStream | Readable):Readable {
  return toStreams2(s)
}

function toStreams2 (s: LazyStream | Readable, opts?:stream.ReadableOptions):Readable {
  if (!s || typeof s === 'function' || (s as any)._readableState) return s as Readable

  var wrap = new stream.Readable(opts).wrap(s)
  if(typeof s !=="string" && s.destroy) {
    (wrap as any).destroy = s.destroy.bind(s)
  }
  return wrap
}

type MultiStreamOptions = stream.ReadableOptions & {
  _errorHandler?: (err:Error)=>boolean
}


class MultiStream extends Readable {
  _drained: boolean
  _forwarding: boolean
  _current: Readable
  _toStreams2: (s: LazyStream | Readable, opts?:{}) => Readable
  _queue: FactoryStream | Array<LazyStream | Readable>
  _errorHandler:(err:Error) => boolean
  constructor (streams:Streams, opts?: MultiStreamOptions) {
    super(opts)
    this.destroyed = false

    this._drained = false
    this._forwarding = false
    this._current = null
    this._toStreams2 = (opts && opts.objectMode) ? toStreams2Obj : toStreams2Buf
    this._errorHandler = opts && opts._errorHandler
    if (typeof streams === 'function') {
      this._queue = streams
    } else {
      this._queue = streams.map(this._toStreams2)
      this._queue.forEach(stream => {
        if (typeof stream !== 'function') this._attachErrorListener(stream)
      })
    }

    this._next()
  }

  _read () {
    this._drained = true
    this._forward()
  }

  _forward () {
    if (this._forwarding || !this._drained || !this._current) return
    this._forwarding = true

    var chunk
    while (this._drained && (chunk = this._current.read()) !== null) {
      this._drained = this.push(chunk)
    }

    this._forwarding = false
  }

  destroy (err?: Error):void {
    if (this.destroyed) return
    this.destroyed = true

    if (this._current && this._current.destroy) this._current.destroy()
    if (typeof this._queue !== 'function') {
      this._queue.forEach(stream => {
        if ((stream as Readable).destroy) (stream as Readable).destroy()
      })
    }

    if (err) this.emit('error', err)
    this.emit('close')
  }

  _next () {
    this._current = null

    if (typeof this._queue === 'function') {
      this._queue((err:Error, stream:Readable) => {
        if (err) return this.destroy(err)
        stream = this._toStreams2(stream)
        this._attachErrorListener(stream)
        this._gotNextStream(stream)
      })
    } else {
      var stream = this._queue.shift()
      if (typeof stream === 'function') {
        stream = this._toStreams2((stream as LazyStream)())
        this._attachErrorListener(stream)
      }
      this._gotNextStream(stream)
    }
  }

  _gotNextStream (stream: Readable) {
    if (!stream) {
      this.push(null)
      this.destroy()
      return
    }

    this._current = stream
    this._forward()

    const onReadable = () => {
      this._forward()
    }

    const onClose = () => {
      if (!(stream as any)._readableState.ended) {
        this.destroy()
      }
    }

    const onEnd = () => {
      this._current = null
      stream.removeListener('readable', onReadable)
      stream.removeListener('end', onEnd)
      stream.removeListener('close', onClose)
      this._next()
    }

    stream.on('readable', onReadable)
    stream.once('end', onEnd)
    stream.once('close', onClose)
  }

  _attachErrorListener (stream: Readable) {
    if (!stream) return

    const onError = (err: Error) => {
      if(!this._errorHandler || !this._errorHandler(err)){
        stream.removeListener('error', onError)
        this.destroy(err)
      }else{
        stream.removeListener('error', onError)
        this._next()
      }
      stream.removeListener('error', onError)
      this.destroy(err)
    }

    stream.once('error', onError)
  }
}


(MultiStream as any).obj = (streams:Streams) => (
  new MultiStream(streams, { objectMode: true, highWaterMark: 16 })
)

module.exports = MultiStream
