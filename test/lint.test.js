const fs = require('fs')
const path = require('path')
const glob = require('glob')

const _ = require('lodash')
const execa = require('execa')
const copy = require('ncp').ncp
const tmp = require('tmp')

const FILE_REGEX = /\s*(\S*\.js):\d+:\d+/
const FILE_REGEX_GLOBAL = /\s*(\S*\.js):\d+:\d+/g

describe('bin/lint.js', () => {
  let tmpDir, results

  function getFullPath(dir) {
    return dir === tmpDir.name ? dir : path.join(__dirname, dir)
  }

  function diffDirectories(dirA, dirB) {
    dirA = getFullPath(dirA)
    dirB = getFullPath(dirB)
    const filesA = glob.sync(path.join(dirA, '**/*.js')).sort()
    const filesB = glob.sync(path.join(dirB, '**/*.js')).sort()
    expect(filesA).to.have.length(filesB.length)
    filesA.forEach((fileA, index) => {
      const contentA = fs.readFileSync(fileA, 'utf8')
      const contentB = fs.readFileSync(filesB[index], 'utf8')
      expect(contentA).to.equal(contentB)
    })
  }

  function parseResult(result) {
    const content = result.stdout
      .split('\n')
      .filter(s => s.trim())
      .join('\t')
      .trim()

    if (!content.match(FILE_REGEX)) {
      return {files: [], byFile: {}}
    }

    const files = content
      .match(FILE_REGEX_GLOBAL)
      .map(item => item.match(FILE_REGEX)[1])
    const fileResults = files
      .map((file, index) => {
        const start = content.indexOf(file) + file.length
        let end = content.indexOf(files[index + 1])
        end = end === -1 ? undefined : end
        const rules = content.slice(start, end)
        return {file, rules}
      })

    return {files, byFile: _.keyBy(fileResults, 'file')}
  }

  function setup(dir, args, beforeLint, done) {
    if (arguments.length === 3) {
      done = beforeLint
      beforeLint = _.noop
    }

    tmpDir = tmp.dirSync({unsafeCleanup: true})
    copy(path.join(__dirname, dir), tmpDir.name, err => {
      if (err) {
        return done(err)
      }

      beforeLint()
      execa(path.join(__dirname, '../bin/lint.js'), args, {cwd: tmpDir.name})
        .catch(err => err)
        .then(result => results = Object.assign(result, parseResult(result)))
        .then(() => done())
        .catch(done)
    })
  }

  function teardown(done, copyBack) {
    const finish = err => {
      if (tmpDir) {
        tmpDir.removeCallback()
      }

      tmpDir = null
      done(err)
    }

    if (copyBack) {
      copy(tmpDir.name, path.join(__dirname, copyBack), finish)
    } else {
      finish()
    }
  }

  context('node', () => {
    before(done => setup('fixtures/node', ['--fix', '--write'], done))
    after(done => teardown(done, 'fixtures/node-actual'))

    describe('source linting', () => {
      it('should exit with error code', () => {
        expect(results.code).to.equal(1)
      })

      it('should find errors in ./', () => {
        expect(results.files).to.contain('toplevel.js')
      })

      it('should find errors in lib/', () => {
        expect(results.files).to.contain('lib/file.js')
      })

      it('should find errors in src/', () => {
        expect(results.files).to.contain('src/file.js')
      })

      it('should find errors in bin/', () => {
        expect(results.files).to.contain('bin/file.js')
      })

      it('should use source config', () => {
        expect(results.byFile).to.have.property('lib/file.js')
        const violations = results.byFile['lib/file.js'].rules
        expect(violations).to.contain('it is not defined')
        expect(violations).to.contain('no-unused-expressions')
      })
    })

    describe('test linting', () => {
      it('should find errors in test/', () => {
        expect(results.files).to.contain('test/file.test.js')
      })

      it('should use test config', () => {
        expect(results.byFile).to.have.property('test/file.test.js')
        const violations = results.byFile['test/file.test.js'].rules
        expect(violations).to.not.contain('it is not defined')
        expect(violations).to.not.contain('no-unused-expressions')
      })
    })

    describe('--fix', () => {
      it('should fix errors', () => {
        diffDirectories(tmpDir.name, 'fixtures/node-expected')
      })
    })

    describe('--write', () => {
      it('should write a .eslintrc file', () => {
        const filePath = path.join(tmpDir.name, '.eslintrc')
        const fileContents = JSON.parse(fs.readFileSync(filePath, 'utf-8'))
        expect(fileContents).to.be.ok
        expect(fileContents).to.have.property('env')
        expect(fileContents).to.have.property('parser')
        expect(fileContents).to.have.property('rules')
      })
    })
  })

  describe('package.json overrides', () => {
    function beforeLint() {
      fs.writeFileSync(path.join(tmpDir.name, 'package.json'), JSON.stringify({
        config: {
          eslint: {
            envs: ['browser'],
            globals: ['__DEV__'],
            rules: {'no-console': 'off'},
          },
        },
      }, null, 2), 'utf-8')
    }

    before(done => setup('fixtures/node-overrides', [], beforeLint, done))
    after(teardown)

    it('should still lint', () => {
      expect(results.byFile).to.have.property('file.js')
      const violations = results.byFile['file.js'].rules
      expect(violations).to.contain('Extra semicolon')
    })

    it('should respect overrides', () => {
      expect(results.byFile).to.have.property('file.js')
      const violations = results.byFile['file.js'].rules
      expect(violations).to.not.contain('document is not defined')
      expect(violations).to.not.contain('__DEV__ is not defined')
      expect(violations).to.not.contain('Unexpected console')
    })
  })

  context('react', () => {
    before(done => setup('fixtures/react', ['-t', 'react', '--fix'], done))
    after(done => teardown(done, 'fixtures/react-actual'))

    describe('linting', () => {
      it('should use browser env', () => {
        expect(results.byFile).to.have.property('file.js')
        const violations = results.byFile['file.js'].rules
        expect(violations).to.not.contain('document is not defined')
        expect(violations).to.not.contain('localStorage is not defined')
      })

      it('should find react-specific errors', () => {
        expect(results.byFile).to.have.property('file.js')
        const violations = results.byFile['file.js'].rules
        expect(violations).to.contain('prop is never used')
        expect(violations).to.contain('key must begin with handle')
        expect(violations).to.contain('Link is not defined')
      })

      it('should use webpack resolution', () => {
        expect(results.byFile).to.have.property('file.js')
        const violations = results.byFile['file.js'].rules
        expect(violations).to.not.contain('Unable to resolve path to module src/dep2')
      })
    })

    describe('--fix', () => {
      it('should fix errors', () => {
        diffDirectories(tmpDir.name, 'fixtures/react-expected')
      })
    })
  })
})
