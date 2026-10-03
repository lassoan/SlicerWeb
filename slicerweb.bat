@echo off
rem Build, publish and try a SlicerWeb application, as a settings file says (see slicerweb.py):
rem
rem     slicerweb.bat D:\SlicerWeb-build\slicerweb-app.env build
rem     slicerweb.bat D:\SlicerWeb-build\slicerweb-app.env deploy latest
python "%~dp0slicerweb.py" %*
