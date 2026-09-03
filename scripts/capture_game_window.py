"""
Capture game window screenshot using BitBlt.
Usage: python capture_game_window.py <output_path> [window_title_regex]
"""
import sys
import os
import re
import ctypes
import ctypes.wintypes
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
    results.append((hwnd, title))
    return True


def find_game_window(title_regex=None):
    """Find a game window matching the title regex."""
    results = []
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.wintypes.BOOL, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    windll.user32.EnumWindows(WNDENUMPROC(enum_windows_callback), 0)
    
    if title_regex:
        pattern = re.compile(title_regex, re.IGNORECASE)
        for hwnd, title in results:
            if pattern.search(title):
                return hwnd, title
    
    # Return all visible windows if no match
    return results


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
    if len(sys.argv) < 2:
        print("Usage: python capture_game_window.py <output_path> [window_title_regex]")
        sys.exit(1)
    
    output_path = sys.argv[1]
    title_regex = sys.argv[2] if len(sys.argv) > 2 else None
    
    result = find_game_window(title_regex)
    if isinstance(result, tuple):
        hwnd, title = result
        print(f"Found window: {title} (hwnd={hwnd})")
        capture_window_by_bitblt(hwnd, output_path)
        print(f"Saved to: {output_path}")
    elif isinstance(result, list):
        print("Available windows:")
        for hwnd, title in result[:20]:
            print(f"  {hwnd}: {title}")
        sys.exit(1)
    else:
        print("No game window found")
        sys.exit(1)
