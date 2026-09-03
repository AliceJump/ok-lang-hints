"""
Capture game window screenshot using BitBlt.
Usage: python capture_game_window.py <output_path> [window_title_regex]
       python capture_game_window.py <output_path> --exe-names Endfield.exe --hwnd-class UnityWndClass
"""
import sys
import os
import re
import ctypes
import ctypes.wintypes
import json
from ctypes import windll, byref, sizeof, c_long

# Constants
DWMWA_EXTENDED_FRAME_BOUNDS = 9
PW_RENDERFULLCONTENT = 0x00000002


def get_window_bounds(hwnd):
    """Get the visual bounds of a window (including DPI scaling)."""
    rect = ctypes.wintypes.RECT()
    windll.dwmapi.DwmGetWindowAttribute(
        hwnd, DWMWA_EXTENDED_FRAME_BOUNDS, byref(rect), sizeof(rect)
    )
    return rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top


def get_client_rect(hwnd):
    """Get the client area rect relative to the window."""
    rect = ctypes.wintypes.RECT()
    windll.user32.GetClientRect(hwnd, byref(rect))
    return rect


def get_exe_by_hwnd(hwnd):
    """Get the executable name and path for a window."""
    try:
        import psutil
        _, pid = windll.user32.GetWindowThreadProcessId(hwnd, None)
        proc = psutil.Process(pid)
        return proc.name(), proc.exe()
    except Exception:
        return None, None


def enum_windows_callback(hwnd, results):
    """Callback for EnumWindows."""
    if not windll.user32.IsWindowVisible(hwnd):
        return True
    length = windll.user32.GetWindowTextLengthW(hwnd)
    if length == 0:
        return True
    buf = ctypes.create_unicode_buffer(length + 1)
    windll.user32.GetWindowTextW(hwnd, buf, length + 1)
    title = buf.value
    class_name_buf = ctypes.create_unicode_buffer(256)
    windll.user32.GetClassNameW(hwnd, class_name_buf, 256)
    class_name = class_name_buf.value
    exe_name, exe_path = get_exe_by_hwnd(hwnd)
    results.append((hwnd, title, class_name, exe_name, exe_path))
    return True


def find_game_window(title_regex=None, exe_names=None, hwnd_class=None):
    """Find a game window matching the criteria.
    
    Args:
        title_regex: Regex pattern to match window title
        exe_names: List of executable names to match
        hwnd_class: Window class name to match
    """
    results = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.wintypes.BOOL, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    windll.user32.EnumWindows(WNDENUMPROC(enum_windows_callback), 0)
    
    # Parse exe_names
    if isinstance(exe_names, str):
        exe_names = [exe_names]
    
    # Parse hwnd_class
    hwnd_class_pattern = None
    if hwnd_class:
        hwnd_class_pattern = re.compile(hwnd_class, re.IGNORECASE)
    
    # Parse title regex
    title_pattern = None
    if title_regex:
        title_pattern = re.compile(title_regex, re.IGNORECASE)
    
    matched = []
    for hwnd, title, cls_name, exe_name, exe_path in results:
        # Check exe name
        if exe_names:
            exe_match = False
            for en in exe_names:
                if exe_name and en.lower() in exe_name.lower():
                    exe_match = True
                    break
                if exe_path and en.lower() in exe_path.lower():
                    exe_match = True
                    break
            if not exe_match:
                continue
        
        # Check window class
        if hwnd_class_pattern and not hwnd_class_pattern.search(cls_name):
            continue
        
        # Check title
        if title_pattern and not title_pattern.search(title):
            continue
        
        matched.append((hwnd, title, cls_name, exe_name, exe_path))
    
    if matched:
        # Pick the biggest window
        best = None
        best_area = 0
        for hwnd, title, cls_name, exe_name, exe_path in matched:
            left, top, width, height = get_window_bounds(hwnd)
            area = width * height
            if area > best_area:
                best_area = area
                best = (hwnd, title)
        if best:
            return best
    
    # Return first match if no biggest found
    if matched:
        return (matched[0][0], matched[0][1])
    
    return None


def capture_window_by_bitblt(hwnd, output_path):
    """Capture a window using BitBlt and save to file."""
    # Get window bounds
    left, top, width, height = get_window_bounds(hwnd)
    
    # Get device contexts
    hwnd_dc = windll.user32.GetWindowDC(hwnd)
    mfc_dc = windll.gdi32.CreateCompatibleDC(hwnd_dc)
    save_dc = windll.gdi32.CreateCompatibleDC(hwnd_dc)
    
    # Create bitmap
    bitmap = windll.gdi32.CreateCompatibleBitmap(hwnd_dc, width, height)
    windll.gdi32.SelectObject(save_dc, bitmap)
    
    # BitBlt from window to save_dc
    result = windll.gdi32.BitBlt(
        save_dc, 0, 0, width, height,
        hwnd_dc, 0, 0, 0x00CC0020  # SRCCOPY
    )
    
    if not result:
        # Try PrintWindow as fallback
        windll.user32.PrintWindow(hwnd, save_dc, PW_RENDERFULLCONTENT)
    
    # Save to file using GDI+
    gdiplus = ctypes.windll.gdiplus
    
    # Initialize GDI+
    class GdiplusStartupInput(ctypes.Structure):
        _fields_ = [
            ("GdiplusVersion", ctypes.c_uint32),
            ("DebugEventCallback", ctypes.c_void_p),
            ("SuppressBackgroundThread", ctypes.c_int),
            ("SuppressExternalCodecs", ctypes.c_int),
        ]
    
    input_struct = GdiplusStartupInput()
    input_struct.GdiplusVersion = 1
    token = ctypes.c_ulong()
    gdiplus.GdiplusStartup(byref(token), byref(input_struct), None)
    
    # Convert HBITMAP to file
    # Use a simpler approach: save via PIL/opencv if available, or use GDI+ encoder
    # For simplicity, we'll use the raw bitmap data approach
    
    # Get bitmap info
    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", ctypes.wintypes.DWORD),
            ("biWidth", ctypes.c_long),
            ("biHeight", ctypes.c_long),
            ("biPlanes", ctypes.wintypes.WORD),
            ("biBitCount", ctypes.wintypes.WORD),
            ("biCompression", ctypes.wintypes.DWORD),
            ("biSizeImage", ctypes.wintypes.DWORD),
            ("biXPelsPerMeter", ctypes.c_long),
            ("biYPelsPerMeter", ctypes.c_long),
            ("biClrUsed", ctypes.wintypes.DWORD),
            ("biClrImportant", ctypes.wintypes.DWORD),
        ]
    
    bmi = BITMAPINFOHEADER()
    bmi.biSize = sizeof(BITMAPINFOHEADER)
    bmi.biWidth = width
    bmi.biHeight = -height  # Top-down
    bmi.biPlanes = 1
    bmi.biBitCount = 32
    bmi.biCompression = 0  # BI_RGB
    
    # Get bitmap bits
    buf_size = width * height * 4
    buf = ctypes.create_string_buffer(buf_size)
    windll.gdi32.GetDIBits(save_dc, bitmap, 0, height, buf, byref(bmi), 0)
    
    # Clean up GDI objects
    windll.gdi32.DeleteObject(bitmap)
    windll.gdi32.DeleteDC(save_dc)
    windll.gdi32.DeleteDC(mfc_dc)
    windll.user32.ReleaseDC(hwnd, hwnd_dc)
    
    gdiplus.GdiplusShutdown(token)
    
    # Save as PNG using PIL if available
    try:
        from PIL import Image
        img = Image.frombytes('RGB', (width, height), buf, 'raw', 'BGRA', 0, -1)
        img.save(output_path, 'PNG')
        return True
    except ImportError:
        pass
    
    # Save as BMP using raw data
    try:
        import numpy as np
        arr = np.frombuffer(buf, dtype=np.uint8).reshape(height, width, 4)
        # Convert BGRA to RGB
        import cv2
        img = cv2.cvtColor(arr, cv2.COLOR_BGRA2BGR)
        cv2.imwrite(output_path, img)
        return True
    except ImportError:
        pass
    
    # Fallback: save as BMP
    bmp_path = output_path.rsplit('.', 1)[0] + '.bmp'
    with open(bmp_path, 'wb') as f:
        # BMP file header
        f.write(b'BM')
        f.write(ctypes.wintypes.DWORD(54 + buf_size).to_bytes(4, 'little'))
        f.write(b'\x00\x00\x00\x00')
        f.write(ctypes.wintypes.DWORD(54).to_bytes(4, 'little'))
        # BMP info header
        f.write(ctypes.wintypes.DWORD(40).to_bytes(4, 'little'))
        f.write(ctypes.c_long(width).to_bytes(4, 'little', signed=True))
        f.write(ctypes.c_long(height).to_bytes(4, 'little', signed=True))
        f.write(ctypes.wintypes.WORD(1).to_bytes(2, 'little'))
        f.write(ctypes.wintypes.WORD(32).to_bytes(2, 'little'))
        f.write(ctypes.wintypes.DWORD(0).to_bytes(4, 'little'))
        f.write(ctypes.wintypes.DWORD(buf_size).to_bytes(4, 'little'))
        f.write(ctypes.c_long(0).to_bytes(4, 'little', signed=True))
        f.write(ctypes.c_long(0).to_bytes(4, 'little', signed=True))
        f.write(ctypes.wintypes.DWORD(0).to_bytes(4, 'little'))
        f.write(ctypes.wintypes.DWORD(0).to_bytes(4, 'little'))
        f.write(buf.raw)
    return True


if __name__ == '__main__':
    import argparse
    
    parser = argparse.ArgumentParser(description='Capture game window screenshot')
    parser.add_argument('output_path', help='Output image path')
    parser.add_argument('title_regex', nargs='?', default=None, help='Window title regex (legacy)')
    parser.add_argument('--exe-names', nargs='+', default=None, help='Executable names to match')
    parser.add_argument('--hwnd-class', default=None, help='Window class name regex')
    parser.add_argument('--config-json', default=None, help='JSON string with window config from probe_window_config')
    
    args = parser.parse_args()
    
    title_regex = args.title_regex
    exe_names = args.exe_names
    hwnd_class = args.hwnd_class
    
    # Parse config JSON if provided
    if args.config_json:
        try:
            config = json.loads(args.config_json)
            if not title_regex and config.get('title'):
                title_regex = config['title']
            if not exe_names and config.get('exe'):
                exe_names = config['exe']
            if not hwnd_class and config.get('hwnd_class'):
                hwnd_class = config['hwnd_class']
        except json.JSONDecodeError:
            pass
    
    result = find_game_window(title_regex, exe_names, hwnd_class)
    if isinstance(result, tuple):
        hwnd, title = result
        print(f"Found window: {title} (hwnd={hwnd})")
        capture_window_by_bitblt(hwnd, args.output_path)
        print(f"Saved to: {args.output_path}")
    else:
        print("No game window found matching the criteria")
        sys.exit(1)
