// Daylens calendar helper. One-shot EventKit read for a local calendar day.
// Spawned by the Electron main process; see src/main/services/calendarSignals.ts.
//
// Prints one JSON object on stdout. Never prints attendee names, locations, or
// notes. The parent app is the TCC-responsible process (Electron does not
// disclaim children), so the Calendar prompt is named Daylens.

import EventKit
import Foundation

struct HelperEvent: Encodable {
  let title: String
  let startHour: Int
  let startMinute: Int
  let durationMinutes: Int
  let attendeeCount: Int?
}

struct HelperSuccess: Encodable {
  let ok = true
  let events: [HelperEvent]
}

struct HelperFailure: Encodable {
  let ok = false
  let error: String
}

func emit(_ value: some Encodable) {
  let encoder = JSONEncoder()
  guard let data = try? encoder.encode(value) else { return }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0a]))
}

func fail(_ code: String, exitCode: Int32) -> Never {
  emit(HelperFailure(error: code))
  exit(exitCode)
}

func canReadEvents() -> Bool {
  if #available(macOS 14.0, *) {
    return EKEventStore.authorizationStatus(for: .event) == .fullAccess
  }
  return EKEventStore.authorizationStatus(for: .event) == .authorized
}

func isDeniedOrRestricted() -> Bool {
  let status = EKEventStore.authorizationStatus(for: .event)
  return status == .denied || status == .restricted
}

func requestAccess(_ store: EKEventStore) -> Bool {
  if canReadEvents() { return true }
  if isDeniedOrRestricted() { return false }

  var granted = false
  var finished = false
  let handler: EKEventStoreRequestAccessCompletionHandler = { ok, _ in
    granted = ok
    finished = true
  }
  if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents(completion: handler)
  } else {
    store.requestAccess(to: .event, completion: handler)
  }
  // EventKit may deliver the callback on the main queue. Pump the run loop
  // instead of blocking it with a semaphore, or the prompt never completes.
  while !finished {
    RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.1))
  }
  return granted
}

func dayInterval(_ raw: String) -> DateInterval? {
  let parts = raw.split(separator: "-")
  guard parts.count == 3,
        let year = Int(parts[0]),
        let month = Int(parts[1]),
        let day = Int(parts[2]),
        year >= 1970, (1...12).contains(month), (1...31).contains(day)
  else { return nil }
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone.current
  guard let start = calendar.date(from: DateComponents(year: year, month: month, day: day)),
        let end = calendar.date(byAdding: .day, value: 1, to: start)
  else { return nil }
  return DateInterval(start: start, end: end)
}

func main() {
  guard CommandLine.arguments.count == 2 else { fail("invalid_arguments", exitCode: 3) }
  guard let interval = dayInterval(CommandLine.arguments[1]) else { fail("invalid_date", exitCode: 3) }

  let store = EKEventStore()
  guard requestAccess(store) else { fail("calendar_access_denied", exitCode: 2) }

  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone.current
  let predicate = store.predicateForEvents(
    withStart: interval.start,
    end: interval.end,
    calendars: store.calendars(for: .event)
  )
  let ekEvents = store.events(matching: predicate).sorted { $0.startDate < $1.startDate }

  var events: [HelperEvent] = []
  for event in ekEvents {
    if event.isAllDay { continue }
    let title = (event.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if title.isEmpty { continue }
    let clippedStart = max(event.startDate, interval.start)
    let clippedEnd = min(event.endDate, interval.end)
    let parts = calendar.dateComponents([.hour, .minute], from: clippedStart)
    guard let hour = parts.hour, let minute = parts.minute else { continue }
    let duration = Int((clippedEnd.timeIntervalSince(clippedStart) / 60.0).rounded())
    if duration < 0 { continue }
    let attendees = event.attendees
    let attendeeCount: Int? = {
      guard let attendees, !attendees.isEmpty else { return nil }
      return attendees.count
    }()
    events.append(HelperEvent(
      title: title,
      startHour: hour,
      startMinute: minute,
      durationMinutes: duration,
      attendeeCount: attendeeCount
    ))
  }
  emit(HelperSuccess(events: events))
}

main()
