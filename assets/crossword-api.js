class CrosswordAPI {
    static baseURL = 'https://crossword-server-aey0.onrender.com';

    static async saveCrossword(imageData) {
        try {
            const response = await fetch(`${this.baseURL}/save-crossword`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: imageData })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to save crossword');
            }

            return data;
        } catch (error) {
            console.error('Save crossword error:', error);
            throw new Error('Failed to save crossword');
        }
    }

    static async getProducts() {
        try {
            const response = await fetch(`${this.baseURL}/products`);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (!data.success && !data.products) {
                throw new Error('Invalid product data received');
            }

            return data;
        } catch (error) {
            console.error('Get products error:', error);
            throw new Error('Failed to fetch products');
        }
    }

    static async getProductSpecs(variantId) {
        try {
            const response = await fetch(`${this.baseURL}/product-specs/${variantId}`);
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (!data.printAreas) {
                throw new Error('Invalid product specifications received');
            }

            return data;
        } catch (error) {
            console.error('Get product specs error:', error);
            throw new Error('Failed to fetch product specifications');
        }
    }

    static async addToCart(variantId, customizations) {
        try {
            const response = await fetch('/cart/add.js', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    items: [{
                        id: variantId,
                        quantity: 1,
                        properties: customizations
                    }]
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Add to cart error:', error);
            throw new Error('Failed to add item to cart');
        }
    }

    static async updateCart(updates) {
        try {
            const response = await fetch('/cart/update.js', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ updates })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Update cart error:', error);
            throw new Error('Failed to update cart');
        }
    }

    static async getCart() {
        try {
            const response = await fetch('/cart.js');
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error('Get cart error:', error);
            throw new Error('Failed to fetch cart');
        }
    }

    static async uploadDesign(designData) {
        try {
            const response = await fetch(`${this.baseURL}/upload-design`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ design: designData })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (!data.success) {
                throw new Error(data.error || 'Failed to upload design');
            }

            return data;
        } catch (error) {
            console.error('Upload design error:', error);
            throw new Error('Failed to upload design');
        }
    }

    static showFeedback(message, isError = false) {
        const modal = document.getElementById('feedback-modal');
        const feedbackMessage = document.getElementById('feedback-message');
        
        if (!modal || !feedbackMessage) {
            console.error('Feedback elements not found');
            alert(message);
            return;
        }

        feedbackMessage.textContent = message;
        feedbackMessage.className = isError ? 'error-message' : 'success-message';
        modal.style.display = 'block';

        setTimeout(() => {
            modal.style.display = 'none';
        }, 3000);
    }
}

// Export for module usage
window.CrosswordAPI = CrosswordAPI;
