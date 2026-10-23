// What /admin shows (src/lib/adminGate.js): signed out goes to sign-in, a signed-in account
// that is not the site admin sees only the plain "This page is for the site admin.", and the
// admin gets the page. The server's refusal of every admin API is in server/routes/admin.test.js.
import test from 'node:test'
import assert from 'node:assert/strict'
import { adminGate, FORBIDDEN_TEXT } from '../src/lib/adminGate.js'

test('signed out goes to sign-in, whatever else is known', () => {
  assert.equal(adminGate({ signedIn: false, isAdmin: null }), 'sign-in')
  assert.equal(adminGate({ signedIn: false, isAdmin: true }), 'sign-in')
})

test('signed in waits for the server before showing anything', () => {
  assert.equal(adminGate({ signedIn: true, isAdmin: null }), 'checking')
  assert.equal(adminGate({ signedIn: true }), 'checking')
})

test('only the server saying admin shows the page; anything else is forbidden', () => {
  assert.equal(adminGate({ signedIn: true, isAdmin: true }), 'show')
  assert.equal(adminGate({ signedIn: true, isAdmin: false }), 'forbidden')
  assert.equal(adminGate({ signedIn: true, isAdmin: 'yes' }), 'forbidden')
  assert.equal(adminGate({ signedIn: true, isAdmin: 1 }), 'forbidden')
})

test('the refusal says the same thing everywhere', () => {
  assert.equal(FORBIDDEN_TEXT, 'This page is for the site admin.')
})
