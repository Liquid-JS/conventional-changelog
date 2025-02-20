'use strict'

const addStream = require('add-stream')
const gitRawCommits = require('git-raw-commits')
const conventionalCommitsParser = require('conventional-commits-parser')
const conventionalChangelogWriter = require('conventional-changelog-writer')
const _ = require('lodash')
const stream = require('stream')
const through = require('through2')
const mergeConfig = require('./lib/merge-config')
function conventionalChangelog (options, context, gitRawCommitsOpts, parserOpts, writerOpts, gitRawExecOpts) {
  writerOpts = writerOpts || {}

  var readable = new stream.Readable({
    objectMode: writerOpts.includeDetails
  })
  readable._read = function () { }

  mergeConfig(options, context, gitRawCommitsOpts, parserOpts, writerOpts, gitRawExecOpts)
    .then(function (data) {
      options = data.options
      context = data.context
      gitRawCommitsOpts = data.gitRawCommitsOpts
      parserOpts = data.parserOpts
      writerOpts = data.writerOpts
      gitRawExecOpts = data.gitRawExecOpts

      var reverseTags = context.gitSemverTags.slice(0).reverse()
      reverseTags.push('HEAD')
      var commitsErrorThrown = false

      var commitsStream = new stream.Readable({
        objectMode: true
      })
      commitsStream._read = function () { }

      function commitsRange (from, to) {
        return gitRawCommits(_.merge({}, gitRawCommitsOpts, {
          from: from,
          to: to
        }))
          .on('error', function (err) {
            if (!commitsErrorThrown) {
              setImmediate(commitsStream.emit.bind(commitsStream), 'error', err)
              commitsErrorThrown = true
            }
          })
      }

      const streams = reverseTags.map((to, i) => {
        const from = i > 0
          ? reverseTags[i - 1]
          : gitRawCommitsOpts.from || ''
        if (gitRawCommitsOpts.from && gitRawCommitsOpts.from !== from) {
          let hasData = false
          return commitsRange(gitRawCommitsOpts.from, to)
            .on('data', function () {
              hasData = true
            })
            .pipe(addStream(() => {
              if (!hasData) {
                const s = new stream.Readable()
                s._read = function () { }
                s.push(null)
                return s
              } else {
                return commitsRange(from, to)
              }
            }))
        } else {
          return commitsRange(from, to)
        }
      })

      if (gitRawCommitsOpts.reverse) {
        streams.reverse()
      }

      streams.reduce((prev, next) => next.pipe(addStream(prev)))
        .on('data', function (data) {
          setImmediate(commitsStream.emit.bind(commitsStream), 'data', data)
        })
        .on('end', function () {
          setImmediate(commitsStream.emit.bind(commitsStream), 'end')
        })

      commitsStream
        .on('error', function (err) {
          err.message = 'Error in git-raw-commits: ' + err.message
          setImmediate(readable.emit.bind(readable), 'error', err)
        })
        .pipe(conventionalCommitsParser(parserOpts))
        .on('error', function (err) {
          err.message = 'Error in conventional-commits-parser: ' + err.message
          setImmediate(readable.emit.bind(readable), 'error', err)
        })
        // it would be better if `gitRawCommits` could spit out better formatted data
        // so we don't need to transform here
        .pipe(through.obj(function (chunk, enc, cb) {
          try {
            options.transform.call(this, chunk, cb)
          } catch (err) {
            cb(err)
          }
        }))
        .on('error', function (err) {
          err.message = 'Error in options.transform: ' + err.message
          setImmediate(readable.emit.bind(readable), 'error', err)
        })
        .pipe(conventionalChangelogWriter(context, writerOpts))
        .on('error', function (err) {
          err.message = 'Error in conventional-changelog-writer: ' + err.message
          setImmediate(readable.emit.bind(readable), 'error', err)
        })
        .pipe(through({
          objectMode: writerOpts.includeDetails
        }, function (chunk, enc, cb) {
          try {
            readable.push(chunk)
          } catch (err) {
            setImmediate(function () {
              throw err
            })
          }

          cb()
        }, function (cb) {
          readable.push(null)

          cb()
        }))
    })
    .catch(function (err) {
      setImmediate(readable.emit.bind(readable), 'error', err)
    })

  return readable
}

module.exports = conventionalChangelog
