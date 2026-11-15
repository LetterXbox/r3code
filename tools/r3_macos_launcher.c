#include <mach-o/dyld.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/wait.h>

/* The supervisor owns the server until this process exits. Only its private
   bootstrap file path travels through the pipe; the credential stays in the file. */
static int start_server(const char *rust_runtime, const char *helper) {
    const char *home = getenv("HOME");
    if (!home || !*home) return -1;
    char data[PATH_MAX], bootstrap_dir[PATH_MAX], parent[32];
    if (snprintf(data, sizeof(data), "%s/.r3/server", home) >= (int)sizeof(data) ||
        snprintf(bootstrap_dir, sizeof(bootstrap_dir), "%s/.t3codegpui/bootstrap", home) >= (int)sizeof(bootstrap_dir)) return -1;
    snprintf(parent, sizeof(parent), "%ld", (long)getpid());
    int output[2];
    if (pipe(output) != 0) return -1;
    pid_t child = fork();
    if (child < 0) { close(output[0]); close(output[1]); return -1; }
    if (child == 0) {
        close(output[0]);
        if (dup2(output[1], STDOUT_FILENO) < 0) _exit(127);
        close(output[1]);
        int null_fd = open("/dev/null", O_RDWR);
        if (null_fd >= 0) { dup2(null_fd, STDIN_FILENO); dup2(null_fd, STDERR_FILENO); if (null_fd > 2) close(null_fd); }
        const char *argv[12];
        int argc = 0;
        argv[argc++] = helper;
        argv[argc++] = "--rust-runtime";
        argv[argc++] = rust_runtime;
        argv[argc++] = "--data-dir";
        argv[argc++] = data;
        argv[argc++] = "--bootstrap-dir";
        argv[argc++] = bootstrap_dir;
        argv[argc++] = "--parent";
        argv[argc++] = parent;
        argv[argc] = NULL;
        execv(helper, (char *const *)argv);
        _exit(127);
    }
    close(output[1]);
    struct pollfd ready = { .fd = output[0], .events = POLLIN };
    char path[PATH_MAX];
    size_t used = 0;
    int ok = 0;
    while (used + 1 < sizeof(path) && poll(&ready, 1, 120000) > 0) {
        char ch;
        if (read(output[0], &ch, 1) != 1) break;
        if (ch == '\n') { path[used] = '\0'; ok = used > 0 && setenv("T3GPUI_BOOTSTRAP_FILE", path, 1) == 0; break; }
        path[used++] = ch;
    }
    close(output[0]);
    if (!ok) { kill(child, SIGTERM); waitpid(child, NULL, 0); return -1; }
    return 0;
}

int main(void) {
    char executable[PATH_MAX], resolved[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0 || !realpath(executable, resolved)) return 1;
    char *slash = strrchr(resolved, '/');
    if (!slash) return 1;
    *slash = '\0';
    char host[PATH_MAX], bundle[PATH_MAX], theme[PATH_MAX], helper[PATH_MAX], python[PATH_MAX], rust_server[PATH_MAX], server_helper[PATH_MAX];
    if (snprintf(host, sizeof(host), "%s/nsh-gpui-host", resolved) >= (int)sizeof(host) ||
        snprintf(bundle, sizeof(bundle), "%s/../Resources/nsh/bundle.nshc", resolved) >= (int)sizeof(bundle) ||
        snprintf(theme, sizeof(theme), "%s/../Resources/nsh/theme-built.json", resolved) >= (int)sizeof(theme) ||
        snprintf(helper, sizeof(helper), "%s/../Resources/theme/r3_theme_supervisor.py", resolved) >= (int)sizeof(helper) ||
        snprintf(python, sizeof(python), "%s/../Resources/python/bin/python3.11", resolved) >= (int)sizeof(python) ||
        snprintf(rust_server, sizeof(rust_server), "%s/../Resources/r3-server/t3code", resolved) >= (int)sizeof(rust_server) ||
        snprintf(server_helper, sizeof(server_helper), "%s/r3-server-supervisor", resolved) >= (int)sizeof(server_helper)) return 1;
    if (!getenv("T3GPUI_BOOTSTRAP_FILE")) {
        if (access(rust_server, X_OK) != 0 || start_server(rust_server, server_helper) != 0) {
            fprintf(stderr, "Could not start the R3 Code local server\n");
            return 1;
        }
    }
    FILE *file = fopen(theme, "r");
    if (file) {
        char value[4096];
        size_t length = fread(value, 1, sizeof(value) - 1, file);
        fclose(file);
        value[length] = '\0';
        if (length) setenv("T3GPUI_BUILT_THEME", value, 1);
    }
    char parent[32];
    snprintf(parent, sizeof(parent), "%ld", (long)getpid());
    pid_t child = fork();
    if (child == 0) {
        setsid();
        int null_fd = open("/dev/null", O_RDWR);
        if (null_fd >= 0) { dup2(null_fd, 0); dup2(null_fd, 1); dup2(null_fd, 2); if (null_fd > 2) close(null_fd); }
        const char *interpreter = access(python, X_OK) == 0 ? python : "/usr/bin/python3";
        execl(interpreter, "python3", "-I", "-S", "-B", helper, parent, (char *)NULL);
        _exit(127);
    }
    char *const args[] = {host, "--bundle", bundle, "--app-id", "com.example.t3ui", "--window-title", "R3 Code", "--wait-for-ui", "--window-size", "1280x800", NULL};
    execv(host, args);
    perror("Could not launch R3 Code");
    return 1;
}
