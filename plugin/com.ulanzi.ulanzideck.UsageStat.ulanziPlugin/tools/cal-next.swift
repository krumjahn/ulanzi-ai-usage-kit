import Foundation
import EventKit
import AppKit

// Reads the next upcoming event on this Mac and prints it as one line of JSON.
//
// Why this exists instead of AppleScript: Calendar.app hands out its stored
// event list over Apple Events, and it evaluates a "whose" filter by building
// every event in the calendar one at a time. That is roughly 50 ms per event,
// so a single "give me the events after now" query on a 2,000 event calendar
// takes nearly two minutes, and the whole 12 calendar set takes minutes more.
// EventKit reads the same database directly, so the same answer comes back in
// milliseconds, and it expands recurring series (the weekly yoga class) into
// real occurrences for us.
//
// Calendar access is protected by macOS privacy settings, so this binary is
// shipped inside a small app bundle. The bundle is what macOS grants (or
// refuses) access to, which keeps the grant independent of whatever program
// happens to launch us.
//
// The result is written to last.json as well as printed, so it can be read
// back whether we were started from a terminal or launched as an app.

let helperDirectory = (ProcessInfo.processInfo.environment["ULANZI_CAL_HELPER_DIR"]
    ?? (NSHomeDirectory() as NSString).appendingPathComponent(".ulanzi/calendar-helper"))
let resultFile = (helperDirectory as NSString).appendingPathComponent("last.json")

func jsonEscape(_ s: String) -> String {
    var out = ""
    for scalar in s.unicodeScalars {
        switch scalar {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        case "\n": out += "\\n"
        case "\r": out += "\\r"
        case "\t": out += "\\t"
        default:
            if scalar.value < 0x20 {
                out += String(format: "\\u%04x", scalar.value)
            } else {
                out.unicodeScalars.append(scalar)
            }
        }
    }
    return out
}

func writeOut(_ raw: String) {
    print(raw)
    fflush(stdout)
    try? FileManager.default.createDirectory(
        atPath: helperDirectory, withIntermediateDirectories: true,
        attributes: [.posixPermissions: 0o700])
    try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helperDirectory)
    try? raw.write(toFile: resultFile, atomically: true, encoding: .utf8)
    try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: resultFile)
}

let arguments = CommandLine.arguments
let debugMode = arguments.contains("--debug")
let daysAhead = 120
let bundleId = Bundle.main.bundleIdentifier ?? "none"

let store = EKEventStore()
let cal = Calendar.current

/// Builds the payload for the next upcoming event, or nil when there is none.
func nextEvent(now: Date) -> (payload: String, found: Bool) {
    let today = cal.startOfDay(for: now)
    let end = cal.date(byAdding: .day, value: daysAhead, to: today)!
    // Start the search at midnight today so an all day event running right now
    // is still visible.
    let predicate = store.predicateForEvents(withStart: today, end: end, calendars: nil)
    let matches = store.events(matching: predicate)

    struct Candidate {
        let day: Date
        let allDay: Bool
        let start: Date
        let event: EKEvent
    }

    var candidates: [Candidate] = []
    for event in matches {
        guard let start = event.startDate else { continue }
        let day = cal.startOfDay(for: start)
        if event.isAllDay {
            if day < today { continue }
        } else {
            if start < now { continue }
        }
        candidates.append(Candidate(day: day, allDay: event.isAllDay, start: start, event: event))
    }

    // Within a single day a timed event is more useful than an all day one, so
    // all day events sort after the timed events of the same day.
    candidates.sort { a, b in
        if a.day != b.day { return a.day < b.day }
        if a.allDay != b.allDay { return !a.allDay }
        return a.start < b.start
    }

    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime]

    guard let first = candidates.first else {
        return ("{\"status\":\"none\",\"at\":\(Int(Date().timeIntervalSince1970)),\"bundle\":\"\(jsonEscape(bundleId))\"}", false)
    }

    var payload = "{\"status\":\"ok\""
    payload += ",\"at\":\(Int(Date().timeIntervalSince1970))"
    payload += ",\"title\":\"\(jsonEscape(first.event.title ?? ""))\""
    payload += ",\"calendar\":\"\(jsonEscape(first.event.calendar.title))\""
    payload += ",\"start\":\"\(iso.string(from: first.start))\""
    payload += ",\"allDay\":\(first.allDay ? "true" : "false")"
    payload += ",\"epoch\":\(Int(first.start.timeIntervalSince1970))"

    if debugMode {
        payload += ",\"count\":\(candidates.count)"
        payload += ",\"now\":\"\(iso.string(from: now))\""
        payload += ",\"upcoming\":["
        for (index, item) in candidates.prefix(6).enumerated() {
            if index > 0 { payload += "," }
            payload += "{\"title\":\"\(jsonEscape(item.event.title ?? ""))\",\"start\":\"\(iso.string(from: item.start))\",\"calendar\":\"\(jsonEscape(item.event.calendar.title))\",\"allDay\":\(item.allDay ? "true" : "false")}"
        }
        payload += "]"
    }
    payload += "}"
    return (payload, true)
}

// .fullAccess == 3, .writeOnly == 4, .denied == 2, .restricted == 1.
var statusRaw = EKEventStore.authorizationStatus(for: .event).rawValue

if statusRaw == 3 {
    // Already allowed: answer straight away, no window, no run loop.
    let result = nextEvent(now: Date())
    writeOut(result.payload)
    exit(result.found ? 0 : 0)
}

// Not allowed yet. This is the one case that needs a real run loop, because
// the privacy prompt is presented by the system while the app is running.
let app = NSApplication.shared
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)

var finished = false
var exitCode: Int32 = 0

func finish(_ raw: String, _ code: Int32) {
    if finished { return }
    finished = true
    writeOut(raw)
    exitCode = code
    DispatchQueue.main.async { app.terminate(nil) }
}

if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { granted, error in
        let status = EKEventStore.authorizationStatus(for: .event).rawValue
        if granted || status == 3 {
            let result = nextEvent(now: Date())
            finish(result.payload, 0)
        } else {
            let reason = error?.localizedDescription ?? "calendar access not granted"
            finish("{\"status\":\"denied\",\"reason\":\"\(jsonEscape(reason))\",\"raw\":\(status),\"bundle\":\"\(jsonEscape(bundleId))\"}", 2)
        }
    }
} else {
    store.requestAccess(to: .event) { granted, error in
        if granted {
            let result = nextEvent(now: Date())
            finish(result.payload, 0)
        } else {
            let reason = error?.localizedDescription ?? "calendar access not granted"
            finish("{\"status\":\"denied\",\"reason\":\"\(jsonEscape(reason))\",\"raw\":\(statusRaw),\"bundle\":\"\(jsonEscape(bundleId))\"}", 2)
        }
    }
}

// Give up if the user never answers the prompt.
DispatchQueue.main.asyncAfter(deadline: .now() + 90) {
    finish("{\"status\":\"denied\",\"reason\":\"prompt timed out\",\"raw\":\(statusRaw),\"bundle\":\"\(jsonEscape(bundleId))\"}", 2)
}

app.run()
exit(exitCode)
