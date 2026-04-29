import path from "path"
import { EventEmitter } from "events"
import got from "got"
import { extension as mimeExtension } from "mime-types"
import { createLogger } from "./logger"
import { loginManager } from "./login"
import { storeIsReady, store } from "./store"
import { generateUID, sanitizePath } from "../util"

const { log, debug } = createLogger("MoodleClient")

export interface Course {
  id: number
  fullname: string
  name: string
  shouldSync: boolean
}

export interface FileInfo {
  coursename: string
  filename: string
  filepath: string
  filesize: number
  fileurl: string
  timecreated: number
  timemodified: number
  updating?: boolean // set to true if the file is already downloaded, and is being updated
}

export type MoodleNotification = {
  id: number
  title: string
  htmlbody: string
  timecreated: number
  read: boolean
  url: string
  courseid?: string
}

function getDefaultName(fullname: string) {
  const m = fullname.match(/\d+ - (.+) \(.+\)/)
  return m ? m[1] : fullname
}

export declare interface MoodleClient {
  on(event: "disconnected", listener: () => void): this
  on(event: "reconnected", listener: () => void): this
  on(event: "network_event", listener: (connected: boolean) => void): this
  on(event: "username", listener: (username: string) => void): this
  on(event: "courses", listener: (courses: Course[]) => void): this
  on(
    event: "notifications",
    listener: (notifications: MoodleNotification[]) => void,
  ): this
}
export class MoodleClient extends EventEmitter {
  username?: string
  userid?: number
  connected = true

  waitingForCourses = false
  cachedCourses: Course[] = []
  cachedNotifications: MoodleNotification[] = []

  constructor() {
    super()
    loginManager.once("ready", () => {
      if (loginManager.isLogged) {
        if (loginManager.username) {
          this.username = loginManager.username
          this.emit("username", loginManager.username)
        }
        this.getNotifications()
        setInterval(
          () => {
            this.getNotifications()
          },
          1000 * 60 * 2,
        )
      }
    })
    loginManager.on("session", () => {
      if (loginManager.username) {
        this.username = loginManager.username
        this.emit("username", loginManager.username)
      }
    })
  }

  /**
   * Sets the {@link connected} parameter to the correct value, and emits the correct events
   * @param conn true when connected, false when disconnected
   */
  private setConnected(conn: boolean) {
    if (this.connected !== conn) {
      this.connected = conn
      log(conn ? "reconneted!" : "disconnected!")
      this.emit("network_event", conn)
      this.emit(conn ? "reconnected" : "disconnected")
    }
  }

  /**
   * This function handles calls to the Moodle Web API
   */
  async call(
    /**
     * the moodle function [Moodle API Docs](https://docs.moodle.org/dev/Web_service_API_functions)
     */
    wsfunction: string,
    /**
     * the data to be passed to moodle in the form
     */
    data?: { [key: string]: unknown },
    /**
     * if false, when a network error occours this function will throw, if
     * true the call will be retried every 2 seconds until a connection can be established, then
     *  the function will resolve normally - default is true
     */
    catchNetworkError = true,
    /**
     * UUID for logging, if not specified a new one will be generated, passed only when retrying
     */
    callUID = generateUID(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    debug(`API call [${callUID}] to function: ${wsfunction}`)
    if (data) debug(`    data: ${JSON.stringify(data)}`)

    if (!loginManager.isLogged) {
      debug(`Call [${callUID}]: not logged in, attempting login`)
      const ok = await loginManager.ensureLoggedIn()
      if (!ok) {
        debug(`Aborting call [${callUID}]: login failed or cancelled`)
        return
      }
      return await this.call(wsfunction, data, catchNetworkError, callUID)
    }
    try {
      // Moodle's AJAX service endpoint: requires sesskey in the query string and MoodleSession cookie.
      // The old wstoken REST endpoint (/webservice/rest/server.php) was replaced because the
      // mobile app token flow it depended on is no longer available due to Polimi not feeling like it.
      // Response is a JSON array; unwrap the first element's `data` field.
      const res = await got.post(
        `https://webeep.polimi.it/lib/ajax/service.php?sesskey=${loginManager.sesskey}`,
        {
          timeout: { request: 10000 },
          json: [{ index: 0, methodname: wsfunction, args: data ?? {} }],
          headers: {
            Cookie: `MoodleSession=${loginManager.moodleSession}`,
          },
        },
      )
      const parsed = JSON.parse(res.body)
      const [result] = Array.isArray(parsed) ? parsed : [parsed]
      if (result.error) {
        const errorcode = result.exception?.errorcode ?? result.errorcode
        debug(`API error on call [${callUID}]: ${errorcode}`)
        // On session expiry attempt silent SSO refresh before prompting a visible login window.
        if (errorcode === "sessionexpired" || errorcode === "invalidsesskey") {
          const refreshed = await loginManager.silentRefresh()
          if (refreshed)
            return await this.call(wsfunction, data, catchNetworkError, callUID)
          const logged = await loginManager.createLoginWindow()
          if (logged)
            return await this.call(wsfunction, data, catchNetworkError, callUID)
        }
      } else {
        this.setConnected(true)
        debug(`API call [${callUID}] success`)
        return result.data
      }
    } catch (e) {
      delete e.timings // useless info to log
      debug(
        `Network error on call [${callUID}], catching: ${catchNetworkError}`,
      )
      debug(e)
      this.setConnected(false)
      if (catchNetworkError) {
        return await new Promise((resolve, reject) => {
          const tryConnection = async () => {
            try {
              debug(`Retring API call [${callUID}]...`)
              resolve(await this.call(wsfunction, data, false, callUID))
              debug(`Retry successful on call [${callUID}]`)
            } catch (e) {
              setTimeout(() => tryConnection(), 2000)
            }
          }
          tryConnection()
        })
      } else throw e
    }
  }

  /**
   * Retrieves the user's enrolled courses, should be called when it's critical to retrieve
   * the correct courses (e.g while searching for new files while syncing), in other cases (e.g
   * when displaying courses in the UI) use {@link getCourses}
   * @param catchNetworkError if set to true, doesn't throw on fail, instead keeps retrying until
   * it succeedes
   * @returns A promise which resolves with the list of the enrolled courses
   */
  async getCoursesWithoutCache(catchNetworkError = false): Promise<Course[]> {
    await storeIsReady()

    // core_enrol_get_users_courses is ajax:false (wstoken-only) and requires a userid we no longer
    // fetch upfront (but can obtain from notifications).
    // core_course_get_enrolled_courses_by_timeline_classification is ajax:true and is
    // the preferred way mandated by Her Highness Polimi (and it also works without a userid).
    const res: { courses: { fullname: string; id: number }[] } =
      await this.call(
        "core_course_get_enrolled_courses_by_timeline_classification",
        { classification: "all", limit: 0, offset: 0 },
        catchNetworkError,
      )
    const courses = res?.courses ?? []
    const defaultNames = courses.map(c => getDefaultName(c.fullname))
    const c: Course[] = courses.map((c, i) => {
      const { id, fullname } = c

      if (!store.data.persistence.courses[id]) {
        // check if there are multiple courses that would be shortened to the same folder
        const allInstances = defaultNames.reduce((arr, el, j) => {
          if (el === defaultNames[i]) {
            arr.push(j)
          }
          return arr
        }, [])

        store.data.persistence.courses[id] = {
          // if multiple courses share the same name, just use the fullname instead
          name: allInstances.length > 1 ? fullname : defaultNames[i],
          shouldSync: store.data.settings.syncNewCourses,
        }
      }

      return {
        id,
        fullname,
        ...store.data.persistence.courses[id],
      }
    })

    store.write()
    this.emit("courses", c)
    this.cachedCourses = c
    return c
  }

  /**
   * Get the user's enrolled courses. If the API call cannot be established, this function returns
   * previously cached courses, then when tha call finally resolves, the updated courses will be
   * passed to the 'courses' event. Should be used only when it's not necessary for the courses to
   * be absolutely correct, in that case {@link getCoursesWithoutCache} should be used
   * @returns A promise which resolves with the list of the enrolled courses
   */
  getCourses(): Course[] {
    if (!this.waitingForCourses) {
      // if not already waiting for the api resposne, make the call and retrieve updated courses
      this.waitingForCourses = true
      this.getCoursesWithoutCache(true).then(() => {
        this.waitingForCourses = false
      })
    }
    return this.cachedCourses
  }

  /**
   * this function calls the moodle api to get all the files to be downloaded from a specified
   * course
   * @param course the course object from {@link getCourses}
   * @returns a promise that resolve to an array with all the FileInfo objects
   */
  /**
   * Uses core_courseformat_get_state instead of core_course_get_contents.
   * core_course_get_contents is ajax:false (wstoken-only), so it can't be called via
   * lib/ajax/service.php. core_courseformat_get_state is ajax:true and returns the same
   * course module data, but as a double-encoded JSON string containing `cm` and `section` arrays.
   *
   * Resources and folders are handled separately:
   * - resource/risorsa: HEAD request → timemodified + Content-Type for filename
   * - folder/cartella: GET page → parse pluginfile links → Range request per file
   * All cm processing runs in parallel; filename deduplication runs after all resolve.
   */
  async getFileInfos(course: Course): Promise<FileInfo[]> {
    const raw = await this.call(
      "core_courseformat_get_state",
      { courseid: course.id },
      false,
    )
    // core_courseformat_get_state returns its payload as a double-encoded JSON string
    const state: {
      cm?: {
        id: number
        modname: string
        name: string
        url?: string
        sectionid?: string | number
        section?: string | number
        uservisible: boolean | number
      }[]
      section?: { id: string | number; num: number; title: string }[]
    } = typeof raw === "string" ? JSON.parse(raw) : raw

    if (!state?.cm) {
      debug(`getFileInfos: no cm in state for course ${course.id}`)
      return []
    }

    debug(`getFileInfos: got ${state.cm.length} cms for course ${course.id}`)

    const sectionTitles = new Map<string | number, string>(
      (state.section ?? []).map(s => [s.id, s.title]),
    )

    const cookie = `MoodleSession=${loginManager.moodleSession}`
    // Re-attach the session cookie on every redirect hop (redirect trap)
    const cookieHook = [
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (opts: any) => {
        opts.headers["cookie"] = cookie
      },
    ]
    const baseOpts = {
      headers: { cookie },
      hooks: { beforeRedirect: cookieHook },
      timeout: { request: 10000 },
    }

    // collect all file infos in parallel, deduplicate at the end
    const undeduped: FileInfo[] = []

    await Promise.all(
      state.cm.map(async cm => {
        if (!cm.uservisible || !cm.url) return

        // sectionid is the primary field; section is a legacy fallback seen on some courses
        const cmSectionId = cm.sectionid ?? cm.section
        const sectionTitle =
          sectionTitles.get(cmSectionId) ??
          sectionTitles.get(String(cmSectionId)) ??
          ""
        // courses where the section is named 'Materiali' or similar skip the section subfolder
        const basepath = sanitizePath(
          sectionTitle.toLowerCase().includes("material")
            ? course.name
            : path.join(course.name, sectionTitle),
        )

        if (["resource", "risorsa"].includes(cm.modname.toLowerCase())) {
          try {
            const moduleUrl = cm.url.replace(/&amp;/g, "&")
            const resp = await got.head(moduleUrl, baseOpts)
            let fileurl = resp.url

            if (!fileurl.includes("pluginfile.php")) {
              // Embedded file: the redirect landed on a page, parse it for the real link
              const page = await got(moduleUrl, baseOpts)
              const match =
                page.body.match(
                  /<object[^>]+data="([^"]*pluginfile\.php[^"]*)"/,
                ) ??
                page.body.match(/<a[^>]+href="([^"]*pluginfile\.php[^"]*)"/)
              if (!match) {
                debug(
                  `getFileInfos: no pluginfile link in "${cm.name}", skipping`,
                )
                return
              }
              fileurl = match[1].replace(/&amp;/g, "&")
            }

            const lastMod = resp.headers["last-modified"]
            const timemodified = lastMod
              ? Math.floor(new Date(lastMod).getTime() / 1000)
              : 0

            // use module display name + extension from Content-Type (original behaviour)
            const contentType = (resp.headers["content-type"] ?? "")
              .split(";")[0]
              .trim()
            const ext = contentType
              ? "." + (mimeExtension(contentType) || "")
              : ""
            const filename = sanitizePath(
              (cm.name + ext).replace(/[/\\]/g, "_"),
            )

            // filesize is 0 here, fetched lazily during download for live progress updates
            undeduped.push({
              coursename: course.name,
              filename,
              filepath: basepath,
              filesize: 0,
              fileurl,
              timecreated: timemodified,
              timemodified,
            })
          } catch (e) {
            debug(
              `getFileInfos: failed to resolve resource "${cm.name}": ${e.message}`,
            )
          }
        } else if (["folder", "cartella"].includes(cm.modname.toLowerCase())) {
          try {
            const folderUrl = cm.url.replace(/&amp;/g, "&")
            const page = await got(folderUrl, baseOpts)
            const folderPath = sanitizePath(path.join(basepath, cm.name))

            const linkRe =
              /href="(https?:\/\/[^"]*pluginfile\.php[^"]*forcedownload=1[^"]*)"/g
            const folderFileUrls: string[] = []
            let match
            while ((match = linkRe.exec(page.body)) !== null) {
              folderFileUrls.push(match[1].replace(/&amp;/g, "&"))
            }

            await Promise.all(
              folderFileUrls.map(async fileurl => {
                // Use stream + early abort so we only read headers, never the body.
                // A plain got() call with Range would download the full file if the server
                // ignores the Range header and responds with 200.
                const { filesize, timemodified } = await new Promise<{
                  filesize: number
                  timemodified: number
                }>((resolve, reject) => {
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  const req = (got.stream as any)(fileurl, {
                    ...baseOpts,
                    headers: { ...baseOpts.headers, range: "bytes=0-0" },
                  })
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  req.once("response", (resp: any) => {
                    const contentRange: string =
                      resp.headers["content-range"] ?? ""
                    const filesize = contentRange
                      ? parseInt(contentRange.split("/").pop(), 10)
                      : 0
                    const lastMod: string = resp.headers["last-modified"] ?? ""
                    const timemodified = lastMod
                      ? Math.floor(new Date(lastMod).getTime() / 1000)
                      : 0
                    req.destroy()
                    resolve({
                      filesize: isNaN(filesize) ? 0 : filesize,
                      timemodified,
                    })
                  })
                  req.once("error", (e: Error) => {
                    // ignore body-abort errors triggered by destroy()
                    if (
                      e.message?.includes("aborted") ||
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      (e as any).code === "ERR_STREAM_DESTROYED"
                    ) {
                      resolve({ filesize: 0, timemodified: 0 })
                    } else {
                      reject(e)
                    }
                  })
                }).catch(e => {
                  debug(
                    `getFileInfos: range request failed for ${fileurl}: ${e.message}`,
                  )
                  return { filesize: 0, timemodified: 0 }
                })

                // pluginfile.php URL structure:
                // /pluginfile.php/{contextId}/{component}/{filearea}/{itemid}/{...relativePath}
                // Everything after the 5th segment is the relative path inside the folder,
                // which may include subfolders (e.g. "Prima sessione/lab_FdA_script.m").
                const urlPath = decodeURIComponent(new URL(fileurl).pathname)
                const parts = urlPath.split("/").filter(Boolean)
                const relParts = parts.slice(5) // skip: pluginfile.php, contextId, component, filearea, itemid
                const filename = sanitizePath(
                  relParts[relParts.length - 1].replace(/[/\\]/g, "_"),
                )
                const subfolderParts = relParts
                  .slice(0, -1)
                  .map(p => sanitizePath(p))
                const filepath =
                  subfolderParts.length > 0
                    ? path.join(folderPath, ...subfolderParts)
                    : folderPath

                undeduped.push({
                  coursename: course.name,
                  filename,
                  filepath,
                  filesize,
                  fileurl,
                  timecreated: timemodified,
                  timemodified,
                })
              }),
            )
          } catch (e) {
            debug(
              `getFileInfos: failed to parse folder "${cm.name}": ${e.message}`,
            )
          }
        }
      }),
    )

    // deduplicate filenames per-directory after all parallel requests complete
    const files: FileInfo[] = []
    for (const file of undeduped) {
      let i = 1
      let deduped = file.filename
      while (
        files.find(f => f.filepath === file.filepath && f.filename === deduped)
      ) {
        const base = path.basename(file.filename, path.extname(file.filename))
        const trimmed =
          i > 1 ? base.slice(0, -(3 + String(i - 1).length)) : base
        deduped = `${trimmed} (${i})${path.extname(file.filename)}`
        i++
      }
      files.push({ ...file, filename: deduped })
    }
    return files
  }

  /**
   * Gets all notifications from the moodle API, as displayed on the webpage
   *
   * Sets the notification cache on call completion and emits the 'notifications' event
   * @returns a promise that resolves to an array with all the Notification objects
   */
  async getNotifications(): Promise<MoodleNotification[]> {
    try {
      // this call can fail silently, the notifications will just not be updated
      // an update will occur anyway when the notifications are checked in the background
      const nots: {
        notifications: {
          id: number
          useridto: number
          subject: string
          fullmessage: string
          fullmessagehtml: string
          contexturl: string
          timecreated: number
          read: boolean
          eventtype: string
          customdata: string
        }[]
      } = await this.call(
        "message_popup_get_popup_notifications",
        { useridto: 0 },
        false,
      )

      // core_webservice_get_site_info (the old source of userid) is ajax:false.
      // message_popup_get_popup_notifications includes useridto on each notification,
      // so we extract it here as a side-effect, it's the only ajax:true way to get our own userid lmao.
      if (!this.userid && nots.notifications.length > 0)
        this.userid = nots.notifications[0].useridto

      const notifications: MoodleNotification[] = nots.notifications
        .filter(n => n.eventtype === "posts")
        .map(n => {
          let courseid: string | undefined
          try {
            courseid = JSON.parse(n.customdata).courseid
          } catch (e) {
            /* no course id found */
          }

          return {
            id: n.id,
            title: n.subject,
            htmlbody: n.fullmessagehtml,
            timecreated: n.timecreated,
            url: n.contexturl,
            read: n.read,
            courseid,
          }
        })

      this.cachedNotifications = notifications
      this.emit("notifications", notifications)
      return notifications
    } catch (e) {
      // return the cache if the call fails
      return this.cachedNotifications
    }
  }

  /**
   * Sets the given notification as read
   * @param notificationID the id of the notification to be marked as read
   */
  async markNotificationAsRead(notificationID: number): Promise<void> {
    // update the cache to avoid showing the notification as unread again
    this.cachedNotifications = this.cachedNotifications.map(n => {
      if (n.id === notificationID) n.read = true
      return n
    })
    this.emit("notifications", this.cachedNotifications) // notify the frontend
    // actually call the api to mark the notification as read
    // done after updating the cache to mark the notification as read even without internet
    // the call will eventually make it through when the user reconnects
    await this.call("core_message_mark_notification_read", {
      notificationid: notificationID,
    })
  }

  /**
   * Marks all notifications as read
   * Same as {@link markNotificationAsRead} but for all notifications instead of just one
   *
   * this also marks every notification that isn't shown in webeep sync as read,
   * like the ones for new materials uploaded.
   */
  async markAllNotificationsAsRead(): Promise<void> {
    // update cache before call as optimistic update
    this.cachedNotifications = this.cachedNotifications.map(n => {
      n.read = true
      return n
    })
    this.emit("notifications", this.cachedNotifications) // notify the frontend
    // timecreatedto is required; without it the server ignores the call silently.
    await this.call("core_message_mark_all_notifications_as_read", {
      useridto: this.userid ?? 0,
      timecreatedto: Math.floor(Date.now() / 1000),
    })
  }
}
export const moodleClient = new MoodleClient()
