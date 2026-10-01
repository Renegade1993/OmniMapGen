@echo off
REM Builds VCMI_rmg.exe from rmgdump.cpp against the DMB engine build (VCMI\build, VCMI_lib.lib).
REM Same compiler, flags and libraries as the engine's own lib target (build.ninja, 2026-10-01):
REM Release, /MD, C++20, boost as DLLs. Output goes beside the run folder's other programs.
REM Linked as a Windows-subsystem program (/SUBSYSTEM:WINDOWS with the console entry point): whatever launches it, it can never
REM own a console window; its stdout still reaches a pipe the parent gives it. K, 2026-10-01: "SOME JERKOFF ... SPAMMING ME WITH CMD WINDOWS".
REM Does not touch the DMB repo or its build tree; only reads headers and the import library.
call "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
set "SRC=%~dp0vcmi-snapshot"
set "CON=C:\Users\Kmoney\.conan2\p"
set "OUT=%~dp0out"
if not exist "%OUT%" mkdir "%OUT%"
cd /d "%~dp0"
cl /nologo /DWIN32 /D_WINDOWS /GR /EHsc /utf-8 /bigobj /wd4250 /wd4251 /wd4244 /wd4267 /wd4275 /MP /O2 /Ob2 /DNDEBUG -std:c++20 -MD ^
 -DBOOST_ALL_DYN_LINK -DBOOST_ALL_NO_LIB "-DDMB_VERSION_STRING=\"0.1.0\"" -DENABLE_BATTLE_AI -DENABLE_EDITOR -DENABLE_LAUNCHER -DENABLE_NULLKILLER2_AI -DENABLE_NULLKILLER_AI -DENABLE_STUPID_AI -DENABLE_TEMPLATE_EDITOR -DHAVE_BZIP2 ^
 -DNTDDI_VERSION=0x06010000 -DVCMI_VERSION_MAJOR=1 -DVCMI_VERSION_MINOR=7 -DVCMI_VERSION_PATCH=5 "-DVCMI_VERSION_STRING=\"1.7.5\"" ^
 -DVCMI_WITH_DEBUG_CONSOLE -DWINVER=0x0601 -D_CRT_SECURE_NO_WARNINGS -D_SCL_SECURE_NO_WARNINGS -D_SILENCE_TR1_NAMESPACE_DEPRECATION_WARNING -D_WIN32_WINNT=0x0601 ^
 -I"%SRC%\lib" -I"%SRC%" -I"%SRC%\include" ^
 -external:I%CON%\miniz1a73c1b095f86\p\include -external:I%CON%\miniz1a73c1b095f86\p\include\minizip -external:I%CON%\bzip2176458ec779e0\p\include ^
 -external:I%CON%\zlibbedb652bac8b7\p\include -external:I%CON%\boost6d656fcebc81b\p\include -external:I%CON%\onetbccbc1726d6e90\p\include -external:W0 ^
 rmgdump.cpp /Fo"%OUT%\\" /Fe"%OUT%\VCMI_rmg.exe" ^
 /link /machine:x64 /INCREMENTAL:NO /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup "%SRC%\bin\VCMI_lib.lib" bcrypt.lib ^
 %CON%\miniz1a73c1b095f86\p\lib\minizip.lib %CON%\zlibbedb652bac8b7\p\lib\zdll.lib ^
 %CON%\boost6d656fcebc81b\p\lib\boost_filesystem.lib %CON%\boost6d656fcebc81b\p\lib\boost_program_options.lib %CON%\boost6d656fcebc81b\p\lib\boost_locale.lib ^
 %CON%\boost6d656fcebc81b\p\lib\boost_thread.lib %CON%\boost6d656fcebc81b\p\lib\boost_date_time.lib %CON%\boost6d656fcebc81b\p\lib\boost_atomic.lib ^
 %CON%\boost6d656fcebc81b\p\lib\boost_chrono.lib %CON%\boost6d656fcebc81b\p\lib\boost_container.lib %CON%\boost6d656fcebc81b\p\lib\libboost_exception.lib ^
 %CON%\onetbccbc1726d6e90\p\lib\tbb.lib %CON%\onetbccbc1726d6e90\p\lib\tbb12.lib
if errorlevel 1 (echo BUILD FAILED & exit /b 1)
echo BUILD OK
