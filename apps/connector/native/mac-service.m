#import <Cocoa/Cocoa.h>
#import <ServiceManagement/ServiceManagement.h>

static NSString *codeHash(NSURL *app) {
  NSTask *verify = [NSTask new];
  verify.executableURL = [NSURL fileURLWithPath:@"/usr/bin/codesign"];
  verify.arguments = @[@"--verify", @"--deep", @"--strict", app.path];
  verify.standardOutput = [NSFileHandle fileHandleWithNullDevice];
  verify.standardError = [NSFileHandle fileHandleWithNullDevice];
  if (![verify launchAndReturnError:nil]) return nil;
  [verify waitUntilExit];
  if (verify.terminationStatus != 0) return nil;
  NSTask *describe = [NSTask new]; NSPipe *pipe = [NSPipe pipe];
  describe.executableURL = verify.executableURL;
  describe.arguments = @[@"-d", @"--verbose=4", app.path];
  describe.standardError = pipe;
  describe.standardOutput = [NSFileHandle fileHandleWithNullDevice];
  if (![describe launchAndReturnError:nil]) return nil;
  NSString *text = [[NSString alloc] initWithData:[pipe.fileHandleForReading readDataToEndOfFile] encoding:NSUTF8StringEncoding];
  [describe waitUntilExit];
  if (describe.terminationStatus != 0) return nil;
  for (NSString *line in [text componentsSeparatedByString:@"\n"])
    if ([line hasPrefix:@"CDHash="]) return line;
  return nil;
}

int main(int argc, const char **argv) { @autoreleasepool {
  if (argc < 3) return 2;
  NSString *mode = @(argv[1]); NSURL *url = [NSURL fileURLWithPath:@(argv[2])];
  if ([mode isEqualToString:@"status"]) {
    printf("%ld\n", (long)[SMAppService statusForLegacyURL:url]); return 0;
  }
  if ([mode isEqualToString:@"startup-error"]) {
    [NSApplication sharedApplication]; [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    BOOL approval = [SMAppService statusForLegacyURL:url] == SMAppServiceStatusRequiresApproval;
    NSAlert *alert = [NSAlert new];
    alert.messageText = approval ? @"Allow Prentice to run in the background" : @"Prentice could not start its connector";
    alert.informativeText = approval
      ? @"macOS has disabled Prentice's background service. In General → Login Items & Extensions, allow Prentice under App Background Activity, then open Prentice again. Opening the website cannot start a disabled Mac service. Your account and history are preserved."
      : [NSString stringWithFormat:@"%@\n\nDetails are saved in ~/.prentice/logs/launcher.log. Your account and history are preserved.", argc > 3 ? @(argv[3]) : @"The background service did not become ready."];
    [alert addButtonWithTitle:approval ? @"Open Login Items" : @"Try Again"];
    [alert addButtonWithTitle:@"Close"];
    [NSApp activateIgnoringOtherApps:YES];
    if ([alert runModal] == NSAlertFirstButtonReturn) {
      if (approval) { [SMAppService openSystemSettingsLoginItems]; return 0; }
      return 10;
    }
    return 0;
  }
  if ([mode isEqualToString:@"finish-install"]) {
    // Only dispose of exact, integrity-verified copies of this installed release
    // in Downloads. Trash is recoverable; persistent Prentice data is never touched.
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *hash = codeHash(url); if (!hash) return 3;
    NSURL *downloads = [fm URLsForDirectory:NSDownloadsDirectory inDomains:NSUserDomainMask].firstObject;
    NSArray<NSURL *> *items = [fm contentsOfDirectoryAtURL:downloads includingPropertiesForKeys:@[NSURLIsSymbolicLinkKey, NSURLFileResourceIdentifierKey] options:NSDirectoryEnumerationSkipsHiddenFiles error:nil];
    id installedID = nil; [url getResourceValue:&installedID forKey:NSURLFileResourceIdentifierKey error:nil];
    NSMutableArray<NSString *> *moved = [NSMutableArray array];
    for (NSURL *candidate in items) {
      if (![candidate.lastPathComponent hasPrefix:@"Prentice"] || ![candidate.pathExtension isEqualToString:@"app"]) continue;
      NSNumber *link = nil; id candidateID = nil;
      [candidate getResourceValue:&link forKey:NSURLIsSymbolicLinkKey error:nil];
      [candidate getResourceValue:&candidateID forKey:NSURLFileResourceIdentifierKey error:nil];
      if (link.boolValue || [installedID isEqual:candidateID]) continue;
      NSBundle *bundle = [NSBundle bundleWithURL:candidate];
      if (![bundle.bundleIdentifier isEqualToString:@"com.prentice.connector"]) continue;
      if (![hash isEqualToString:codeHash(candidate)]) continue;
      NSURL *trashed = nil;
      if ([fm trashItemAtURL:candidate resultingItemURL:&trashed error:nil] && trashed) [moved addObject:trashed.path];
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:@{@"movedCopies": moved} options:0 error:nil];
    printf("%s\n", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding].UTF8String); return 0;
  }
  return 2;
} }
