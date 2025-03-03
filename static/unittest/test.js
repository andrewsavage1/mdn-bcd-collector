//
// mdn-bcd-collector: static/unittest/test.js
// Unittests for harness.js
//
// © Google LLC, Gooborg Studios
// See the LICENSE file for copyright details
//

/* global mocha, chai, sinon, describe, it, beforeEach, afterEach, window,
          location */
/* global bcd, reusableInstances */

mocha.setup({
  ui: 'bdd',
  reporter: location.hash === '#reporter=json' ? 'json' : 'html'
});

var assert = chai.assert;

describe('harness.js', function() {
  describe('addInstance', function() {
    beforeEach(function() {
      sinon.stub(window.console, 'error');
    });

    it('valid', function(done) {
      bcd.addInstance('foo', 'return 123');
      assert.equal(reusableInstances.foo, 123);
      done();
    });

    it('invalid', function(done) {
      bcd.addInstance('foo', 'foobar');
      assert.equal(reusableInstances.foo, false);
      done();
    });

    afterEach(function() {
      window.console.error.restore();
    });
  });

  describe('run tests', function() {
    it('no tests', function(done) {
      bcd.go(function(results) {
        assert.isEmpty(results);
        done();
      });
    });

    it('return true', function(done) {
      bcd.addTest('name', [{code: 'true'}], 'Window');
      bcd.go(function(results) {
        assert.deepStrictEqual(results, [{
          name: 'name',
          result: true,
          info: {code: 'true', exposure: 'Window'}
        }]);
        done();
      });
    });

    it('return false', function(done) {
      bcd.addTest('name', [{code: 'false'}], 'Window');
      bcd.go(function(results) {
        assert.deepStrictEqual(results, [{
          name: 'name',
          result: false,
          info: {code: 'false', exposure: 'Window'}
        }]);
        done();
      });
    });

    it('return null', function(done) {
      bcd.addTest('name', [{code: 'null'}], 'Window');
      bcd.go(function(results) {
        assert.deepStrictEqual(results, [{
          name: 'name',
          result: null,
          message: 'returned null',
          info: {code: 'null', exposure: 'Window'}
        }]);
        done();
      });
    });

    it('return symbol', function(done) {
      if (typeof Symbol === 'undefined') {
        this.skip();
      }
      bcd.addTest('name', [{code: 'Symbol(\'bar\')'}], 'Window');
      bcd.go(function(results) {
        assert.deepStrictEqual(results, [{
          name: 'name',
          result: null,
          message: 'returned Symbol(bar)',
          info: {code: 'Symbol(\'bar\')', exposure: 'Window'}
        }]);
        done();
      });
    });

    it('return undefined', function(done) {
      bcd.addTest('name', [{code: 'undefined'}], 'Window');
      bcd.go(function(results) {
        assert.deepStrictEqual(results, [{
          name: 'name',
          result: null,
          message: 'returned undefined',
          info: {code: 'undefined', exposure: 'Window'}
        }]);
        done();
      });
    });

    it('return results object', function(done) {
      bcd.addTest('name', [{code: '(function() {return {result: true, message: "foo bar"}})()'}], 'Window');
      bcd.go(function(results) {
        assert.deepStrictEqual(results, [{
          name: 'name',
          result: true,
          message: 'foo bar',
          info: {code: '(function() {return {result: true, message: "foo bar"}})()', exposure: 'Window'}
        }]);
        done();
      });
    });

    it('return non-results object', function(done) {
      bcd.addTest('name', [{code: '(function() {return {error: true}})()'}], 'Window');
      bcd.go(function(results) {
        assert.deepStrictEqual(results, [{
          name: 'name',
          result: null,
          message: 'returned [object Object]',
          info: {code: '(function() {return {error: true}})()', exposure: 'Window'}
        }]);
        done();
      });
    });

    it('throw error', function(done) {
      bcd.addTest('name', [{code: 'throw new Error(\'something went wrong\')'}], 'Window');
      bcd.go(function(results) {
        assert.deepStrictEqual(results, [{
          name: 'name',
          result: null,
          message: 'threw Error: something went wrong',
          info: {code: 'throw new Error(\'something went wrong\')', exposure: 'Window'}
        }]);
        done();
      });
    });

    it('include info', function(done) {
      bcd.addTest('ctx', [{code: 'true'}], 'Window', {'extra': 'stuff'});
      bcd.go(function(results) {
        assert.deepStrictEqual(results[0].info, {
          extra: 'stuff', code: 'true', exposure: 'Window'
        });
        done();
      });
    });

    it('two tests', function(done) {
      bcd.addTest('first', [{code: 'true'}], 'Window', {a: 1});
      bcd.addTest('second', [{code: 'false'}], 'Window', {b: 2});
      bcd.go(function(results) {
        assert.deepEqual(results, [{
          name: 'first',
          result: true,
          info: {code: 'true', exposure: 'Window', a: 1}
        }, {
          name: 'second',
          result: false,
          info: {code: 'false', exposure: 'Window', b: 2}
        }]);
        done();
      });
    });
  });
});

mocha.run();
