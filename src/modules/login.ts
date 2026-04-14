import path from "path"
import { EventEmitter } from "events"
import fs from "fs/promises"
import { app, BrowserWindow, session, safeStorage } from "electron"

import { createLogger } from "./logger"
const { log, debug } = createLogger("LoginManager")

/** @file the path to the session file which stores the encrypted session data */
const sessionPath = path.join(app.getPath("userData"), "session")

interface StoredSession {
  moodleSession: string
  sesskey: string
  expiresAt: number
  username?: string
}

declare interface LoginManager {
  on(eventName: "ready", handler: () => void): this
  on(eventName: "session", handler: () => void): this
  on(eventName: "logout", handler: () => void): this
  once(eventName: "ready", handler: () => void): this
  once(eventName: "session", handler: () => void): this
  once(eventName: "logout", handler: () => void): this
}
class LoginManager extends EventEmitter {
  ready = false
  moodleSession: string
  sesskey: string
  username?: string
  isLogged = false

  loginWindow?: BrowserWindow

  constructor() {
    super()

    // reads the session file, if the file exists, decrypts the content and restores the session
    fs.readFile(sessionPath)
      .then(enc => {
        const stored: StoredSession = JSON.parse(safeStorage.decryptString(enc))
        // check expiry before restoring to avoid sesskey errors on first API call
        if (stored.expiresAt > Date.now()) {
          log("previous session found!")
          this.moodleSession = stored.moodleSession
          this.sesskey = stored.sesskey
          this.username = stored.username
          this.isLogged = true
        } else {
          log("previous session expired")
        }
      })
      .catch(() => log("session not found"))
      .finally(() => this.emit("ready"))
  }

  /**
   * Extracts MoodleSession cookie and sesskey from the loaded /my/ page, then saves them
   * encrypted to disk. Called after both visible and silent logins.
   */
  private async extractAndSaveSession(
    webContents: Electron.WebContents,
  ): Promise<void> {
    // MoodleSession is the cookie Electron's session store received during the SSO flow
    const cookies = await session.defaultSession.cookies.get({
      name: "MoodleSession",
      domain: "webeep.polimi.it",
    })
    const moodleSession = cookies[0]?.value
    if (!moodleSession)
      throw new Error("MoodleSession cookie not found after login")

    // M.cfg is Moodle's global JS config object injected into every page.
    // sesskey is required for every call to lib/ajax/service.php.
    // sessiontimeout tells us when to expire the stored session on disk.
    const cfgStr: string = await webContents.executeJavaScript(
      "JSON.stringify(M.cfg)",
    )
    const { sesskey, sessiontimeout } = JSON.parse(cfgStr) as {
      sesskey: string
      sessiontimeout: number
    }

    // core_webservice_get_site_info (the old way to get the username) is ajax:false and
    // it can only be called with a wstoken, not via lib/ajax/service.php.
    // The /my/ page we're already on has the display name in the DOM, so we scrape it.
    const fullnameRaw: string = await webContents.executeJavaScript(
      "document.querySelector('span.rui-fullname')?.textContent?.trim() ?? ''",
    )
    const username = fullnameRaw
      ? fullnameRaw.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
      : undefined
    debug(
      `extractAndSaveSession: username=${username} sesskey=${sesskey?.slice(0, 6)}... sessiontimeout=${sessiontimeout}`,
    )

    this.moodleSession = moodleSession
    this.sesskey = sesskey
    this.username = username
    this.isLogged = true

    // Persist encrypted so the session survives app restarts without re-login.
    // sessiontimeout is in seconds; * 1000 converts to ms to match Date.now(). Fallback 28800s = 8h.
    const expiresAt = Date.now() + (sessiontimeout ?? 28800) * 1000
    const data: StoredSession = { moodleSession, sesskey, expiresAt, username }
    await fs.writeFile(
      sessionPath,
      safeStorage.encryptString(JSON.stringify(data)),
    )
  }

  /**
   * unsets the session and deletes the session file
   */
  async logout() {
    this.moodleSession = undefined
    this.sesskey = undefined
    this.username = undefined
    this.isLogged = false
    this.emit("logout")
    try {
      // if the file does not exist, just ignore the error when trying to unlink it
      await fs.unlink(sessionPath)
      // eslint-disable-next-line no-empty
    } catch (e) {}
  }

  /**
   * open the login window, if it's already open, focus it
   *
   * The login process starts at the Shibboleth entry point for WeBeep. The user is redirected
   * through aunicalogin, SPID/CIE identity provider, etc. as they normally would in a browser.
   * When the user is finally redirected to /my/, login is complete: MoodleSession cookie and
   * sesskey are extracted from the loaded page and saved encrypted to disk.
   *
   * If at any time before the session is extracted the window closes, a failed login attempt is
   * assumed and {@link logout} gets called.
   *
   * @returns {Promise<boolean>} resolves to true if the user logs in, to false if the window
   * gets closed without the login process completing
   */
  createLoginWindow(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      if (!this.loginWindow) {
        debug("Creating Login Window...")
        // create the window if it doesn't exist
        this.loginWindow = new BrowserWindow({
          height: 600,
          width: 1000,
          autoHideMenuBar: true,
          frame: true,
          parent: BrowserWindow.getAllWindows()[0],
          webPreferences: {
            webSecurity: false,
          },
        })
        // load the login entry point of WeBeep
        this.loginWindow.loadURL(
          "https://webeep.polimi.it/auth/shibboleth/index.php",
        )
        this.loginWindow.once("closed", () => {
          this.loginWindow = undefined
        })
      } else this.loginWindow.focus() // if the window already exists, focus it

      // called when the window gets closed before the session is extracted
      const onclose = async () => {
        log("Login process aborted!")
        await this.logout()
        resolve(false)
      }
      this.loginWindow.once("close", onclose)

      // /my/ is the Moodle dashboard. Reaching it means the SSO flow completed successfully
      this.loginWindow.webContents.on("did-finish-load", async () => {
        if (!this.loginWindow) return
        const url = this.loginWindow.webContents.getURL()
        if (!url.startsWith("https://webeep.polimi.it/my/")) return

        log("Login process completed!")
        this.loginWindow.removeListener("close", onclose)
        try {
          await this.extractAndSaveSession(this.loginWindow.webContents)
          this.emit("session")
          this.loginWindow.destroy()
          resolve(true)
        } catch (e) {
          debug("Failed to extract session after login: " + e)
          await this.logout()
          resolve(false)
        }
      })
    })
  }

  /**
   * Attempts to silently refresh the MoodleSession and sesskey using the existing SSO cookies
   * stored in the Electron session, without opening a visible browser window.
   *
   * Navigates to the Shibboleth entry point in a hidden window. If the SSO cookies are still
   * valid, the SAML flow completes automatically and a fresh MoodleSession is extracted.
   * If the SSO cookies have expired, the flow stalls on the AunicaLogin form and this method
   * returns false, the caller should then fall back to {@link createLoginWindow}.
   *
   * @returns {Promise<boolean>} true if refresh succeeded, false if SSO cookies are expired
   */
  async silentRefresh(): Promise<boolean> {
    return new Promise(resolve => {
      debug("Attempting silent refresh...")
      const win = new BrowserWindow({
        show: false,
        webPreferences: { webSecurity: false },
      })

      // one-shot guard: did-finish-load fires multiple times during redirects
      let resolved = false
      const cleanup = (result: boolean) => {
        if (resolved) return
        resolved = true
        if (!win.isDestroyed()) win.destroy()
        resolve(result)
      }

      // 20s covers the full SAML redirect chain; if we haven't reached /my/ by then, give up
      const timeout = setTimeout(() => {
        debug("silentRefresh timed out")
        cleanup(false)
      }, 20000)

      win.webContents.on("did-finish-load", async () => {
        const url = win.webContents.getURL()
        debug(`silentRefresh: page loaded at ${url}`)

        if (url.startsWith("https://webeep.polimi.it/my/")) {
          clearTimeout(timeout)
          try {
            await this.extractAndSaveSession(win.webContents)
            log("Silent refresh successful")
            cleanup(true)
          } catch (e) {
            debug("Silent refresh failed to extract session: " + e)
            cleanup(false)
          }
          return
        }

        // If navigation has stalled on the AunicaLogin form, SSO cookies are expired.
        // Wait 3 seconds, if still on the same page, the auto-submit did not fire.
        if (url.includes("aunicalogin.jsp")) {
          setTimeout(() => {
            if (
              !resolved &&
              !win.isDestroyed() &&
              win.webContents.getURL().includes("aunicalogin.jsp")
            ) {
              debug("silentRefresh: stuck on aunicalogin.jsp, SSO expired")
              clearTimeout(timeout)
              cleanup(false)
            }
          }, 3000)
        }
      })

      win.loadURL("https://webeep.polimi.it/auth/shibboleth/index.php")
    })
  }
}

/**
 * Manages the MoodleSession and sesskey for web authentication, saves them encrypted on login
 * and restores them on app launch. Also manages the login window.
 * @see {@link LoginManager.createLoginWindow} for more about how the login process works
 */
export const loginManager = new LoginManager()
