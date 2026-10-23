#import <Cocoa/Cocoa.h>
#include <stdio.h>

// A real GUI helper lets a connector started by launchd present a visible panel.
// No Finder/System Events automation permission is needed.
int main(void) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    [app finishLaunching];
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    [panel setTitle:@"Prentice — Choose a project folder"];
    [panel setPrompt:@"Open project"];
    [panel setCanChooseDirectories:YES];
    [panel setCanChooseFiles:NO];
    [panel setAllowsMultipleSelection:NO];
    [panel setCanCreateDirectories:NO];
    // Supports macOS 13.5 as well as newer systems. This is an explicit user action.
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    [app activateIgnoringOtherApps:YES];
#pragma clang diagnostic pop
    [panel makeKeyAndOrderFront:nil];
    if ([panel runModal] == NSModalResponseOK && panel.URL.isFileURL) {
      puts(panel.URL.path.UTF8String);
    }
  }
  return 0;
}
