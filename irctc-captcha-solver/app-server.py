import argparse
import numpy as np
from PIL import Image, ImageEnhance, ImageFilter
import io
import base64
import easyocr
import re
from flask import Flask, request, jsonify

# Initialize EasyOCR Reader
reader = easyocr.Reader(["en"], model_storage_directory="./EasyOCR")

# Initialize Flask app
app = Flask(__name__)

def preprocess_image(image: Image.Image) -> np.ndarray:
    """
    Enhance the image for better OCR accuracy on IRCTC style captchas.
    """
    # Upscale the image 3x to help OCR
    w, h = image.size
    image = image.resize((w * 3, h * 3), Image.LANCZOS)

    # Convert to grayscale
    image = image.convert("L")

    # Increase contrast
    enhancer = ImageEnhance.Contrast(image)
    image = enhancer.enhance(3.0)

    # Increase sharpness
    enhancer = ImageEnhance.Sharpness(image)
    image = enhancer.enhance(2.0)

    # Apply a slight median filter to remove noise
    image = image.filter(ImageFilter.MedianFilter(size=3))

    return np.array(image)

def extract_text_from_image(base64_image: str) -> str:
    try:
        # Handle both with and without data URL prefix
        if "," in base64_image:
            # strip data:image/xxx;base64, prefix
            base64_data = base64_image.split(",", 1)[1]
        else:
            base64_data = base64_image

        image_bytes = base64.b64decode(base64_data)
        image_buffer = io.BytesIO(image_bytes)
        image = Image.open(image_buffer).convert("RGB")

        # Preprocess
        cv_image = preprocess_image(image)

        # EasyOCR with allowlist of alphanumeric chars only (captchas are alphanumeric)
        result = reader.readtext(
            cv_image,
            detail=0,
            allowlist="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
        )

        if result:
            text = "".join(result).replace(" ", "")
            # IRCTC captchas are typically 6 chars
            print(f"[OCR] Extracted: '{text}'")
            return text
        else:
            print("[OCR] No text found, returning ABCDEF")
            return "ABCDEF"

    except Exception as e:
        print(f"[OCR] Error: {e}")
        return f"Error: {str(e)}"


@app.route("/extract-text", methods=["POST"])
def extract_text():
    data = request.get_json()
    base64_image = data.get("image", "")

    if not base64_image:
        return jsonify({"error": "No base64 image string provided"}), 400

    extracted_text = extract_text_from_image(base64_image)
    return jsonify({"extracted_text": extracted_text})


@app.route("/")
def health_check():
    return "Server is running", 200


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run the OCR extraction server.")
    parser.add_argument("--host", type=str, default="0.0.0.0")
    parser.add_argument("--port", type=int, default=5000)
    args = parser.parse_args()
    print(f"[OCR Server] Starting on {args.host}:{args.port}")
    app.run(host=args.host, port=args.port)
