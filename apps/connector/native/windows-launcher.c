/* MSI-owned per-user background entry point. No self-copy, service, or startup mutation. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <wchar.h>
#include <stdio.h>
static HANDLE connector;
static void stop_connector(void) {
  if(connector && WaitForSingleObject(connector,0)==WAIT_TIMEOUT) {
    /* Owner EOF makes the coding-agent guardian terminate its Job Object. */
    TerminateProcess(connector,130);
    WaitForSingleObject(connector,5000);
  }
}
static LRESULT CALLBACK window_proc(HWND window,UINT message,WPARAM wparam,LPARAM lparam) {
  if(message==WM_QUERYENDSESSION) return TRUE;
  if(message==WM_ENDSESSION && wparam) {stop_connector();PostQuitMessage(0);return 0;}
  if(message==WM_CLOSE) {stop_connector();PostQuitMessage(0);return 0;}
  if(message==WM_TIMER && connector && WaitForSingleObject(connector,0)==WAIT_OBJECT_0) {
    DWORD code;GetExitCodeProcess(connector,&code);PostQuitMessage((int)code);return 0;
  }
  return DefWindowProcW(window,message,wparam,lparam);
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE previous,LPWSTR arguments,int show) {
  wchar_t directory[32768],node[32768],script[32768],config[32768],line[32768];
  DWORD length=GetModuleFileNameW(NULL,directory,32768);
  if(!length || length>=32768 || !wcsrchr(directory,L'\\')) return 125;
  *wcsrchr(directory,L'\\')=0;
  if(wcslen(directory)>10000) return 125;
  swprintf(node,32768,L"%ls\\node.exe",directory);
  swprintf(script,32768,L"%ls\\connector.mjs",directory);
  swprintf(config,32768,L"%ls\\prentice.config.json",directory);
  swprintf(line,32768,L"\"%ls\" \"%ls\"",node,script);
  SetEnvironmentVariableW(L"PRENTICE_PACKAGED",L"1");
  SetEnvironmentVariableW(L"PRENTICE_APP_PATH",directory);
  SetEnvironmentVariableW(L"PRENTICE_CONFIG",config);
  /* MSI owns the Run key and shortcut, so the connector must not create a scheduled task. */
  SetEnvironmentVariableW(L"PRENTICE_INSTALL_LOGIN_ITEM",L"0");
  WNDCLASSW cls={0};cls.lpfnWndProc=window_proc;cls.hInstance=instance;cls.lpszClassName=L"PrenticeBackground";
  if(!RegisterClassW(&cls)) return 125;
  HWND window=CreateWindowW(cls.lpszClassName,L"Prentice",WS_OVERLAPPED,0,0,0,0,NULL,NULL,instance,NULL);
  if(!window) return 125;
  STARTUPINFOW startup={0};startup.cb=sizeof(startup);PROCESS_INFORMATION process={0};
  if(!CreateProcessW(node,line,NULL,NULL,FALSE,CREATE_NO_WINDOW,NULL,directory,&startup,&process)) {
    MessageBoxW(NULL,L"Prentice could not start its installed runtime. Repair or reinstall Prentice; your projects and saved state are not removed.",L"Prentice",MB_OK|MB_ICONERROR);
    DestroyWindow(window);return 125;
  }
  connector=process.hProcess;CloseHandle(process.hThread);
  /* Restart Manager may close/restart this installed application during an upgrade. */
  RegisterApplicationRestart(L"",0);
  SetTimer(window,1,250,NULL);
  MSG message={0};while(GetMessageW(&message,NULL,0,0)>0) {TranslateMessage(&message);DispatchMessageW(&message);}
  stop_connector();CloseHandle(connector);DestroyWindow(window);
  return (int)message.wParam;
}
