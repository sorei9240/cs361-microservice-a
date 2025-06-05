import requests
from dotenv import load_dotenv
import socket

load_dotenv()

API_KEY = "Hgz2jg17T4TJ3oq5iODoH_ENwVhQj9p3lM6tvzO9LXg"
BASE_URL = "https://api.unsplash.com"
HEADERS = {'Authorization': f'Client-ID {API_KEY}'}
print("key:", API_KEY)

my_socket = socket.socket()
host = socket.gethostname()
my_port = 1249
my_socket.bind((host, my_port))
my_socket.listen()

def search_images(query, num_images=10):
    endpoint = f"{BASE_URL}/search/photos"
    params = {'query': query, 'per_page': num_images}
    response = requests.get(endpoint, headers=HEADERS, params=params)
    response.raise_for_status()
    return response.json()['results']

def get_image_data(image_url):
    """Download image data and return as bytes (don't save to file)"""
    response = requests.get(image_url, stream=True)
    response.raise_for_status()
    
    image_data = b''
    for chunk in response.iter_content(8192):
        image_data += chunk
    
    print(f"Downloaded image data: {len(image_data)} bytes")
    return image_data

while True:
    print("Waiting for connection...")
    my_connection, addr_main = my_socket.accept()
    print("Connection accepted from " + repr(addr_main[1]))
    
    try:
        search_term = my_connection.recv(10240).decode('utf-8')
        print(f"Search term: {search_term}")
        
        results = search_images(search_term)

        if results:
            # Get the first image
            image = results[0]
            image_url = image['urls']['regular']
            print("URL:", image_url)
            
            # Download image data (don't save to file)
            image_data = get_image_data(image_url)
            
            # Send image data over TCP connection
            my_connection.sendall(image_data)
            print("Image data sent successfully")
            
        else:
            print("ERROR: No images found for the given query.")
            
    except Exception as e:
        print(f"Error processing request: {e}")
    finally:
        my_connection.close()
        print("Connection closed")
