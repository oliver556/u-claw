#import <Cocoa/Cocoa.h>
#include <errno.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/file.h>
#include <fcntl.h>
#include <time.h>
#include <unistd.h>

#include "generated-start-script.inc"

static NSString *gLogPath;
static NSString *gUsbLauncherLogPath;
static NSString *gMainLogPath;
static NSDate *gLauncherStarted;
static NSWindow *gWindow;
static NSTextView *gTextView;
static NSTask *gTask;
static unsigned long long gLogStartOffset = 0;
static int gExitCode = 0;
static BOOL gWindowHidden = YES;
static int gLockFd = -1;

static void mkdir_p(const char *path) {
  char buffer[4096];
  size_t length = strlen(path);
  if (length >= sizeof(buffer)) return;
  memcpy(buffer, path, length + 1);
  for (char *cursor = buffer + 1; *cursor; cursor += 1) {
    if (*cursor != '/') continue;
    *cursor = '\0';
    mkdir(buffer, 0755);
    *cursor = '/';
  }
  mkdir(buffer, 0755);
}

static void append_launcher_log(NSString *message) {
  NSString *line = [NSString stringWithFormat:@"[%@] [U-Claw] %@\n", [[NSDate date] descriptionWithLocale:nil], message];
  int fd = open(gLogPath.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd < 0) return;
  const char *bytes = line.UTF8String;
  if (bytes) write(fd, bytes, strlen(bytes));
  close(fd);
}

static BOOL copy_file_c(const char *source, const char *destination) {
  int in_fd = open(source, O_RDONLY);
  if (in_fd < 0) return NO;
  int out_fd = open(destination, O_WRONLY | O_CREAT | O_TRUNC, 0755);
  if (out_fd < 0) {
    close(in_fd);
    return NO;
  }

  char buffer[65536];
  BOOL ok = YES;
  for (;;) {
    ssize_t bytes_read = read(in_fd, buffer, sizeof(buffer));
    if (bytes_read == 0) break;
    if (bytes_read < 0) {
      ok = NO;
      break;
    }
    ssize_t written = 0;
    while (written < bytes_read) {
      ssize_t chunk = write(out_fd, buffer + written, (size_t)(bytes_read - written));
      if (chunk <= 0) {
        ok = NO;
        break;
      }
      written += chunk;
    }
    if (!ok) break;
  }

  close(in_fd);
  close(out_fd);
  chmod(destination, 0755);
  return ok;
}

static BOOL write_file_c(const char *destination, const char *content) {
  int out_fd = open(destination, O_WRONLY | O_CREAT | O_TRUNC, 0755);
  if (out_fd < 0) return NO;
  size_t length = strlen(content);
  size_t written = 0;
  BOOL ok = YES;
  while (written < length) {
    ssize_t chunk = write(out_fd, content + written, length - written);
    if (chunk <= 0) {
      ok = NO;
      break;
    }
    written += (size_t)chunk;
  }
  close(out_fd);
  chmod(destination, 0755);
  return ok;
}

static unsigned long long file_size(NSString *path) {
  if (!path) return 0;
  struct stat st;
  if (stat(path.fileSystemRepresentation, &st) != 0) return 0;
  if (st.st_size < 0) return 0;
  return (unsigned long long)st.st_size;
}

static NSArray<NSString *> *tail_lines_from_offset(NSString *path, unsigned long long offset, NSUInteger maxLines) {
  int fd = open(path.fileSystemRepresentation, O_RDONLY);
  if (fd < 0) return @[];

  off_t end = lseek(fd, 0, SEEK_END);
  if (end < 0) {
    close(fd);
    return @[];
  }
  unsigned long long size = (unsigned long long)end;
  if (size <= offset) {
    close(fd);
    return @[];
  }
  if (size - offset > 16384) offset = size - 16384;
  if (lseek(fd, (off_t)offset, SEEK_SET) < 0) {
    close(fd);
    return @[];
  }

  size_t length = (size_t)(size - offset);
  char *buffer = (char *)malloc(length + 1);
  if (!buffer) {
    close(fd);
    return @[];
  }
  ssize_t bytesRead = read(fd, buffer, length);
  close(fd);
  if (bytesRead <= 0) {
    free(buffer);
    return @[];
  }
  buffer[bytesRead] = '\0';

  NSString *text = [[NSString alloc] initWithBytesNoCopy:buffer
    length:(NSUInteger)bytesRead
    encoding:NSUTF8StringEncoding
    freeWhenDone:YES];
  if (text.length == 0) return @[];
  text = [[text stringByReplacingOccurrencesOfString:@"\r\n" withString:@"\n"]
    stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
  if (text.length == 0) return @[];

  NSArray<NSString *> *lines = [text componentsSeparatedByString:@"\n"];
  if (lines.count <= maxLines) return lines;
  return [lines subarrayWithRange:NSMakeRange(lines.count - maxLines, maxLines)];
}

static NSDate *log_line_date(NSString *line) {
  if (![line hasPrefix:@"["]) return [NSDate distantPast];
  NSRange end = [line rangeOfString:@"]"];
  if (end.location == NSNotFound || end.location <= 1) return [NSDate distantPast];
  NSString *raw = [line substringWithRange:NSMakeRange(1, end.location - 1)];
  NSDateFormatter *formatter = [[NSDateFormatter alloc] init];
  formatter.locale = [NSLocale localeWithLocaleIdentifier:@"en_US_POSIX"];
  formatter.dateFormat = @"yyyy-MM-dd'T'HH:mm:ss.SSS'Z'";
  formatter.timeZone = [NSTimeZone timeZoneForSecondsFromGMT:0];
  NSDate *date = [formatter dateFromString:raw];
  return date ?: [NSDate distantPast];
}

static NSArray<NSString *> *tail_lines_since(NSString *path, NSUInteger maxLines, NSDate *since) {
  NSArray<NSString *> *lines = tail_lines_from_offset(path, 0, maxLines * 4);
  if (lines.count == 0) return @[];
  NSMutableArray<NSString *> *filtered = [NSMutableArray array];
  for (NSString *line in lines) {
    if ([log_line_date(line) compare:since] == NSOrderedAscending) continue;
    [filtered addObject:line];
  }
  if (filtered.count <= maxLines) return filtered;
  return [filtered subarrayWithRange:NSMakeRange(filtered.count - maxLines, maxLines)];
}

static BOOL has_text(NSString *text, NSString *needle) {
  return [text rangeOfString:needle].location != NSNotFound;
}

static BOOL is_shutdown_status(NSString *status) {
  return has_text(status, @"Shutdown started") ||
    has_text(status, @"Shutdown requested") ||
    has_text(status, @"Stopping gateway") ||
    has_text(status, @"Stopping video adapter") ||
    has_text(status, @"Stopping config server") ||
    has_text(status, @"Shutdown complete") ||
    has_text(status, @"Syncing runtime data back to USB") ||
    has_text(status, @"portable sync ok (before-stop)") ||
    has_text(status, @"portable sync ok (after-stop)") ||
    has_text(status, @"launcher-final-sync");
}

static NSString *initial_status_text(void) {
  return @"U-Claw 正在启动...\n\n首次启动需要复制和解压程序缓存，可能需要几十秒。\n后续同版本启动会复用缓存。";
}

static NSString *status_text(void) {
  NSMutableArray<NSString *> *lines = [tail_lines_from_offset(gLogPath, gLogStartOffset, 18) mutableCopy];
  if (!lines) lines = [NSMutableArray array];
  NSDate *since = [gLauncherStarted dateByAddingTimeInterval:-2.0];
  [lines addObjectsFromArray:tail_lines_since(gMainLogPath, 8, since)];
  if (lines.count > 18) {
    lines = [[lines subarrayWithRange:NSMakeRange(lines.count - 18, 18)] mutableCopy];
  }
  if (lines.count == 0) return initial_status_text();

  NSString *body = [lines componentsJoinedByString:@"\n"];
  NSString *title = is_shutdown_status(body) ? @"U-Claw 正在关闭..." : @"U-Claw 正在启动...";
  return [NSString stringWithFormat:@"%@\n\n%@", title, body];
}

static BOOL should_show_status_window(NSString *status) {
  if (is_shutdown_status(status)) return YES;
  if ([[NSDate date] timeIntervalSinceDate:gLauncherStarted] < 1.2) return NO;
  if (has_text(status, @"Starting U-Claw")) return NO;
  return has_text(status, @"Installing updated app cache") ||
    has_text(status, @"Copying Mac archive") ||
    has_text(status, @"Decompressing Mac app") ||
    has_text(status, @"Checking Mac archive") ||
    has_text(status, @"Checking mandatory hard update") ||
    has_text(status, @"Hard update staged") ||
    has_text(status, @"[hard-update-client]") ||
    has_text(status, @"Syncing USB data to runtime cache") ||
    has_text(status, @"Runtime data has unsynced changes");
}

static void show_window(void) {
  if (!gWindow || !gWindowHidden) return;
  [gWindow center];
  [gWindow makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  gWindowHidden = NO;
}

static void hide_window(void) {
  if (!gWindow || gWindowHidden) return;
  [gWindow orderOut:nil];
  gWindowHidden = YES;
}

static void update_status_window(void) {
  NSString *status = status_text();
  [gTextView setString:status];

  if (gWindowHidden && should_show_status_window(status)) {
    show_window();
  }
  if (!gWindowHidden && has_text(status, @"Starting U-Claw") && !is_shutdown_status(status)) {
    hide_window();
  }
}

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, copy) NSString *root;
@property(nonatomic, copy) NSString *script;
@property(nonatomic, copy) NSString *logDir;
@property(nonatomic, copy) NSString *usbLogPath;
@end

@implementation AppDelegate
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  [self createWindow];
  [self startScript];
  [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *timer) {
    update_status_window();
    if (!gTask.isRunning) {
      [timer invalidate];
      update_status_window();
      if (gExitCode != 0) show_window();
      [NSApp terminate:nil];
    }
  }];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  (void)sender;
  return NO;
}

- (void)createWindow {
  NSRect frame = NSMakeRect(0, 0, 680, 430);
  gWindow = [[NSWindow alloc] initWithContentRect:frame
    styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable)
    backing:NSBackingStoreBuffered
    defer:NO];
  [gWindow setTitle:@"U-Claw Launcher"];
  [gWindow setBackgroundColor:[NSColor colorWithCalibratedWhite:0.04 alpha:1.0]];

  NSScrollView *scrollView = [[NSScrollView alloc] initWithFrame:NSMakeRect(18, 18, 644, 394)];
  [scrollView setHasVerticalScroller:YES];
  [scrollView setBorderType:NSNoBorder];
  [scrollView setBackgroundColor:[NSColor colorWithCalibratedWhite:0.04 alpha:1.0]];

  gTextView = [[NSTextView alloc] initWithFrame:NSMakeRect(0, 0, 644, 394)];
  [gTextView setEditable:NO];
  [gTextView setSelectable:YES];
  [gTextView setDrawsBackground:YES];
  [gTextView setBackgroundColor:[NSColor colorWithCalibratedWhite:0.04 alpha:1.0]];
  [gTextView setTextColor:[NSColor colorWithCalibratedWhite:0.88 alpha:1.0]];
  [gTextView setFont:[NSFont monospacedSystemFontOfSize:13 weight:NSFontWeightRegular]];
  [gTextView setString:initial_status_text()];
  [scrollView setDocumentView:gTextView];

  [[gWindow contentView] addSubview:scrollView];
}

- (void)startScript {
  mkdir_p(self.logDir.fileSystemRepresentation);
  int fd = open(gLogPath.fileSystemRepresentation, O_WRONLY | O_CREAT | O_APPEND, 0644);
  NSFileHandle *logHandle = fd >= 0 ? [[NSFileHandle alloc] initWithFileDescriptor:fd closeOnDealloc:YES] : nil;

  gTask = [[NSTask alloc] init];
  [gTask setLaunchPath:@"/bin/bash"];
  [gTask setArguments:@[self.script]];
  NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
  env[@"UCLAW_LAUNCHER_GUI"] = @"1";
  env[@"UCLAW_LAUNCHER_PID"] = [NSString stringWithFormat:@"%d", getpid()];
  if (self.root) env[@"UCLAW_PORTABLE_ROOT"] = self.root;
  if (gLogPath) env[@"UCLAW_LAUNCHER_LOCAL_LOG"] = gLogPath;
  if (self.usbLogPath) env[@"UCLAW_USB_LAUNCHER_LOG"] = self.usbLogPath;
  env[@"UCLAW_MAC_ARM64_ARCHIVE_SHA256"] = [NSString stringWithUTF8String:kMacArm64ArchiveHash];
  env[@"UCLAW_MAC_X64_ARCHIVE_SHA256"] = [NSString stringWithUTF8String:kMacX64ArchiveHash];
  [gTask setEnvironment:env];
  [gTask setCurrentDirectoryPath:NSTemporaryDirectory()];
  if (logHandle) {
    [gTask setStandardOutput:logHandle];
    [gTask setStandardError:logHandle];
  }

  @try {
    [gTask launch];
  } @catch (NSException *exception) {
    gExitCode = 1;
    NSString *message = [NSString stringWithFormat:@"U-Claw Launcher: failed to launch script: %@\n", exception.reason ?: @""];
    [message writeToFile:gLogPath atomically:NO encoding:NSUTF8StringEncoding error:nil];
    return;
  }

  [gTask setTerminationHandler:^(NSTask *task) {
    gExitCode = task.terminationStatus;
  }];
}
@end

static uint64_t fnv1a64(const char *value) {
  uint64_t hash = 1469598103934665603ULL;
  for (const unsigned char *cursor = (const unsigned char *)value; *cursor; cursor += 1) {
    unsigned char ch = *cursor;
    if (ch >= 'A' && ch <= 'Z') ch = (unsigned char)(ch + ('a' - 'A'));
    hash ^= ch;
    hash *= 1099511628211ULL;
  }
  return hash;
}

static void relaunch_request_path(char *buffer, size_t size, const char *root) {
  snprintf(buffer, size, "%s/data/.uclaw-launcher/relaunch.request", root);
}

static void clear_relaunch_request(const char *root) {
  char request_path[4096];
  relaunch_request_path(request_path, sizeof(request_path), root);
  unlink(request_path);
}

static void write_relaunch_request(const char *root) {
  char dir[4096];
  char request_path[4096];
  snprintf(dir, sizeof(dir), "%s/data/.uclaw-launcher", root);
  mkdir_p(dir);
  relaunch_request_path(request_path, sizeof(request_path), root);
  int fd = open(request_path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) return;
  dprintf(fd, "%ld\n", (long)time(NULL));
  close(fd);
}

static BOOL has_fresh_relaunch_request(const char *root) {
  char request_path[4096];
  struct stat st;
  relaunch_request_path(request_path, sizeof(request_path), root);
  if (stat(request_path, &st) != 0) return NO;
  if (time(NULL) - st.st_mtime > 120) {
    unlink(request_path);
    return NO;
  }
  unlink(request_path);
  return YES;
}

static BOOL existing_launch_is_closing(void) {
  NSDate *since = [[NSDate date] dateByAddingTimeInterval:-600.0];
  NSArray<NSString *> *lines = tail_lines_since(gMainLogPath, 40, since);
  BOOL closing = NO;
  for (NSString *line in lines) {
    if (has_text(line, @"Shutdown started") ||
      has_text(line, @"Shutdown requested") ||
      has_text(line, @"Stopping gateway") ||
      has_text(line, @"Stopping video adapter") ||
      has_text(line, @"Stopping config server")) {
      closing = YES;
    }
    if (has_text(line, @"Shutdown complete") ||
      has_text(line, @" starting...") ||
      has_text(line, @"Gateway ready on port")) {
      closing = NO;
    }
  }
  return closing;
}

static BOOL acquire_single_instance_lock(const char *root) {
  char lock_path[4096];
  char lock_dir[4096];
  snprintf(lock_dir, sizeof(lock_dir), "%s/Library/Caches/U-Claw/launcher-locks", getenv("HOME") ?: "/tmp");
  mkdir_p(lock_dir);
  snprintf(lock_path, sizeof(lock_path), "%s/%016llx.lock", lock_dir, (unsigned long long)fnv1a64(root));
  gLockFd = open(lock_path, O_WRONLY | O_CREAT, 0644);
  if (gLockFd < 0) return YES;
  if (flock(gLockFd, LOCK_EX | LOCK_NB) != 0) {
    write_relaunch_request(root);
    close(gLockFd);
    gLockFd = -1;
    return NO;
  }
  return YES;
}

static int run_launcher_once(NSApplication *app, const char *root, const char *script, const char *log_dir, const char *log_path) {
  gLauncherStarted = [NSDate date];
  gLogPath = [NSString stringWithUTF8String:log_path];
  if (gUsbLauncherLogPath) {
    [[NSFileManager defaultManager] removeItemAtPath:gLogPath error:nil];
  }
  gLogStartOffset = file_size(gLogPath);
  gExitCode = 0;
  gWindowHidden = YES;
  append_launcher_log(@"Launcher run started.");

  AppDelegate *delegate = [[AppDelegate alloc] init];
  delegate.root = [NSString stringWithUTF8String:root];
  delegate.script = [NSString stringWithUTF8String:script];
  delegate.logDir = [NSString stringWithUTF8String:log_dir];
  delegate.usbLogPath = gUsbLauncherLogPath;
  [app setDelegate:delegate];
  [app run];
  return gExitCode;
}

int main(void) {
  @autoreleasepool {
    char executable[4096];
    char resolved_executable[4096];
    uint32_t executable_size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &executable_size) != 0) {
      fprintf(stderr, "U-Claw Launcher: _NSGetExecutablePath failed\n");
      return 1;
    }
    if (realpath(executable, resolved_executable) == NULL) {
      fprintf(stderr, "U-Claw Launcher: realpath failed for %s\n", executable);
      return 1;
    }

    char root[4096];
    strncpy(root, resolved_executable, sizeof(root) - 1);
    root[sizeof(root) - 1] = '\0';
    char *bundle_suffix = strstr(root, "/U-Claw Launcher.app/Contents/MacOS/");
    if (bundle_suffix == NULL) {
      fprintf(stderr, "U-Claw Launcher: bundle suffix missing for %s\n", root);
      return 1;
    }
    *bundle_suffix = '\0';

    char local_script_dir[4096];
    char local_script[4096];
    char log_dir[4096];
    char log_path[4096];
    char usb_log_path[4096];
    snprintf(local_script_dir, sizeof(local_script_dir), "%s/Library/Caches/U-Claw/launcher-bin", getenv("HOME") ?: "/tmp");
    mkdir_p(local_script_dir);
    snprintf(local_script, sizeof(local_script), "%s/Mac-Start-App.command", local_script_dir);
    if (!write_file_c(local_script, kMacStartScript)) {
      fprintf(stderr, "U-Claw Launcher: failed to write launch script to local cache\n");
      return 1;
    }
    snprintf(log_dir, sizeof(log_dir), "%s/Library/Caches/U-Claw/launcher-logs", getenv("HOME") ?: "/tmp");
    snprintf(log_path, sizeof(log_path), "%s/U-Claw-Launcher.log", log_dir);
    snprintf(usb_log_path, sizeof(usb_log_path), "%s/data/logs/U-Claw-Launcher.log", root);
    mkdir_p(log_dir);
    gLogPath = [NSString stringWithUTF8String:log_path];
    gUsbLauncherLogPath = [NSString stringWithUTF8String:usb_log_path];
    gMainLogPath = [NSString stringWithFormat:@"%s/data/logs/main.log", root];
    if (!acquire_single_instance_lock(root)) return 0;
    clear_relaunch_request(root);

    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];

    run_launcher_once(app, root, local_script, log_dir, log_path);
    if (gExitCode == 0 && has_fresh_relaunch_request(root)) {
      append_launcher_log(@"Relaunch requested while U-Claw was closing; starting again.");
      if (gLockFd >= 0) {
        close(gLockFd);
        gLockFd = -1;
      }
      execl(resolved_executable, resolved_executable, NULL);
      append_launcher_log(@"Failed to relaunch after shutdown request.");
    }
    if (gLockFd >= 0) close(gLockFd);
    return gExitCode;
  }
}
