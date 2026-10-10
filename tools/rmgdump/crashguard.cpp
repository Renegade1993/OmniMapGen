// crashguard.cpp - the harness program never shows a crash dialog and always says what it was doing when it died.
//
// K, 2026-10-01: a visible "VCMI_rmg.exe - Application Error: ... could not be written" appeared while the harness
// ran. Built apart from rmgdump.cpp because that file redefines `private` to read the engine's generator, which
// the Windows headers do not tolerate.
//   crashGuardInstall()   no Windows error box for faults, critical errors or missing files; an unhandled exception
//                         (or an abort) writes <out>.crash.txt and ends the process with exit code 99
//   crashGuardJob(...)    the template, seed and output path the process is working on, for that file
#include <windows.h>
#include <crtdbg.h>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>

static char g_template[256] = "?", g_out[1024] = "";
static int g_seed = -1;

static void writeCrash(const char * what, unsigned long code, const void * addr, unsigned long long extra0, unsigned long long extra1)
{
	char module[512] = "?";
	unsigned long long offset = 0;
	HMODULE mod = nullptr;
	if(addr && GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT, (LPCSTR)addr, &mod) && mod)
	{
		GetModuleFileNameA(mod, module, sizeof(module));
		offset = (unsigned long long)addr - (unsigned long long)mod;
	}
	char line[2048];
	std::snprintf(line, sizeof(line), "CRASH\ttemplate=%s\tseed=%d\t%s\tcode=0x%08lX\taddress=%p\tmodule=%s+0x%llX\taccess=%s at 0x%llX\n",
		g_template, g_seed, what, code, addr, module, offset, extra0 == 0 ? "read" : extra0 == 1 ? "write" : "other", extra1);
	std::fputs(line, stdout);
	std::fflush(stdout);
	if(g_out[0])
	{
		char path[1100];
		std::snprintf(path, sizeof(path), "%s.crash.txt", g_out);
		if(FILE * f = std::fopen(path, "wb"))
		{
			std::fputs(line, f);
			std::fclose(f);
		}
	}
}

static LONG WINAPI filter(EXCEPTION_POINTERS * e)
{
	const EXCEPTION_RECORD * r = e->ExceptionRecord;
	unsigned long long a0 = r->NumberParameters > 0 ? r->ExceptionInformation[0] : 9, a1 = r->NumberParameters > 1 ? r->ExceptionInformation[1] : 0;
	writeCrash("unhandled exception", r->ExceptionCode, r->ExceptionAddress, a0, a1);
	TerminateProcess(GetCurrentProcess(), 99);
	return EXCEPTION_EXECUTE_HANDLER;
}

static void onAbort(int)
{
	writeCrash("abort", 0, nullptr, 9, 0);
	TerminateProcess(GetCurrentProcess(), 99);
}

extern "C" void crashGuardInstall()
{
	SetErrorMode(SEM_NOGPFAULTERRORBOX | SEM_FAILCRITICALERRORS | SEM_NOOPENFILEERRORBOX);
	SetUnhandledExceptionFilter(filter);
	_set_abort_behavior(0, _WRITE_ABORT_MSG | _CALL_REPORTFAULT);
	std::signal(SIGABRT, onAbort);
	_CrtSetReportMode(_CRT_ASSERT, 0);
	_CrtSetReportMode(_CRT_ERROR, 0);
}

extern "C" void crashGuardJob(const char * templateName, int seed, const char * out)
{
	std::strncpy(g_template, templateName, sizeof(g_template) - 1);
	g_seed = seed;
	std::strncpy(g_out, out, sizeof(g_out) - 1);
}
